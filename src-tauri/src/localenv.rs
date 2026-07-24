// Local process-environment fix (Phase 36.6).
//
// macOS GUI apps launched from Finder/launchd inherit a *minimal* PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`) — not the user's shell PATH. So a packaged
// `.app` that runs `Command::new("docker")` on a local tab can't find the CLI,
// which Docker Desktop / Homebrew install in `/usr/local/bin`, `/opt/homebrew/bin`,
// or `~/.docker/bin`. `tauri dev` and local *terminal* tabs work because they
// inherit / source the login shell's PATH; the direct local `Command` here did
// not — hence "Docker unavailable" *only* in `tauri build`, and Retry could not
// help (PATH is fixed for the process lifetime). `git` happened to be unaffected
// (it lives in `/usr/bin`, which the minimal PATH keeps) but shares this helper
// for parity — a Homebrew-only `git` would hit the same wall.
//
// Fix: reconstruct a usable PATH for local spawns from (1) the login shell's PATH
// (exactly what the user's terminal — and `tauri dev` — see), queried once and
// cached, plus (2) the well-known dirs as a fallback so we still work if the probe
// fails. The program is resolved to an absolute path so the lookup is unambiguous.
// The actual command is still spawned WITHOUT a shell — args stay verbatim, so no
// injection surface is added (only PATH is fixed). On non-unix this is a no-op
// (GUI apps inherit the system PATH there).

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Marker prefixing the PATH the shell probe echoes, so we can pick it out of any
/// prompt/MOTD noise an interactive shell prints before our command runs.
#[cfg(unix)]
const PATH_MARKER: &str = "__VTERM_PATH__=";

/// Well-known executable dirs a macOS GUI PATH tends to miss. Also valid on Linux
/// (harmless if absent); empty on Windows (GUI apps inherit the system PATH).
#[cfg(unix)]
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"), // Apple-Silicon Homebrew
        PathBuf::from("/usr/local/bin"),    // Intel Homebrew / Docker Desktop symlink
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join(".docker/bin")); // newer Docker Desktop CLI
    }
    dirs
}

#[cfg(not(unix))]
fn well_known_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// Merge PATH sources into one `PATH` value, earlier sources winning on lookup.
/// Order: login-shell PATH (most faithful to the user's terminal), current process
/// PATH, then the well-known fallback dirs. Duplicate and empty entries are dropped,
/// keeping the first occurrence. Pure — unit-tested.
fn combine_paths(sources: &[OsString], well_known: &[PathBuf]) -> OsString {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for src in sources {
        for dir in std::env::split_paths(src) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            if seen.insert(dir.clone()) {
                dirs.push(dir);
            }
        }
    }
    for dir in well_known {
        if seen.insert(dir.clone()) {
            dirs.push(dir.clone());
        }
    }
    std::env::join_paths(&dirs).unwrap_or_else(|_| sources.first().cloned().unwrap_or_default())
}

/// Resolve a program name to an absolute executable path using `path`. An explicit
/// path (absolute or containing a separator) is returned unchanged. A bare name is
/// searched on each `PATH` entry; the first existing file wins. If nothing matches,
/// the name is returned unchanged so `Command` still performs its own lookup —
/// yielding a clean ENOENT the caller can classify as "not installed". Pure —
/// unit-tested.
pub fn resolve_program(prog: &str, path: &OsStr) -> OsString {
    let p = Path::new(prog);
    if p.is_absolute() || p.components().count() > 1 {
        return OsString::from(prog);
    }
    for dir in std::env::split_paths(path) {
        let cand = dir.join(prog);
        if cand.is_file() {
            return cand.into_os_string();
        }
    }
    OsString::from(prog)
}

/// Pull the PATH out of the shell probe's stdout: the value after the last
/// `__VTERM_PATH__=` marker line (an interactive shell may print a prompt/MOTD to
/// stdout before our command runs). None if the marker is absent or empty. Pure.
#[cfg(unix)]
fn parse_marker_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .find_map(|l| l.trim().strip_prefix(PATH_MARKER))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Query the login shell's PATH by running `$SHELL -ilc 'echo <marker>$PATH'`
/// (login + interactive so both profile and rc PATH edits count), bounded by a
/// short timeout so a slow/hanging profile can't stall the first local spawn.
/// Returns None on any failure — the well-known dirs then carry the fallback.
#[cfg(unix)]
async fn query_login_shell_path() -> Option<OsString> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let script = format!("echo {PATH_MARKER}$PATH");
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.args(["-ilc", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_marker_line(&stdout).map(OsString::from)
}

#[cfg(not(unix))]
async fn query_login_shell_path() -> Option<OsString> {
    None
}

/// The login-shell PATH, queried once and cached for the process lifetime.
static LOGIN_PATH: tokio::sync::OnceCell<Option<OsString>> = tokio::sync::OnceCell::const_new();

async fn login_path_cached() -> Option<OsString> {
    LOGIN_PATH.get_or_init(query_login_shell_path).await.clone()
}

/// PATH to use for local child processes: the cached login-shell PATH merged with
/// the current process PATH and the well-known fallback dirs. On non-unix this is
/// just the current PATH.
async fn local_path() -> OsString {
    let mut sources: Vec<OsString> = Vec::new();
    if let Some(login) = login_path_cached().await {
        sources.push(login);
    }
    if let Some(cur) = std::env::var_os("PATH") {
        sources.push(cur);
    }
    combine_paths(&sources, &well_known_dirs())
}

/// Prepare a local spawn: resolve `prog` against the reconstructed local PATH and
/// return `(resolved_program, path)` so the caller does `Command::new(program)`
/// and `.env("PATH", path)`. The command itself is still run without a shell.
pub async fn resolved_local(prog: &str) -> (OsString, OsString) {
    let path = local_path().await;
    let resolved = resolve_program(prog, &path);
    (resolved, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a PATH-style list with the separator of the platform running the test.
    ///
    /// A literal `"a:b"` is not a PATH list — it is a POSIX PATH list. `combine_paths`
    /// splits with `std::env::split_paths`, which is platform-aware on purpose (`:` on
    /// unix, `;` on Windows), because on Windows the string it receives is the real
    /// Windows `PATH`. Hard-coding `:` therefore handed the Windows run one unsplittable
    /// entry, and the test failed on correct code — caught by the Windows runner the
    /// first time one existed.
    fn path_list(parts: &[&str]) -> OsString {
        std::env::join_paths(parts.iter().map(Path::new)).expect("test path list is valid")
    }

    #[test]
    fn combine_paths_dedups_preserving_first() {
        let a = path_list(&["/opt/homebrew/bin", "/usr/bin"]);
        let b = path_list(&["/usr/bin", "/custom"]); // /usr/bin is a dup
        let wk = vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin")];
        let got = combine_paths(&[a, b], &wk);
        let dirs: Vec<PathBuf> = std::env::split_paths(&got).collect();
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/custom"),
                PathBuf::from("/usr/local/bin"),
            ]
        );
    }

    #[test]
    fn combine_paths_skips_empty_entries() {
        let got = combine_paths(&[path_list(&["/a", "", "/b"])], &[]);
        let dirs: Vec<PathBuf> = std::env::split_paths(&got).collect();
        assert_eq!(dirs, vec![PathBuf::from("/a"), PathBuf::from("/b")]);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_program_finds_on_path() {
        // /bin/sh exists on macOS and Linux — a real bare-name lookup.
        let got = resolve_program("sh", OsStr::new("/nope:/bin:/usr/bin"));
        assert_eq!(got, OsString::from("/bin/sh"));
    }

    #[test]
    fn resolve_program_passes_through_explicit_path() {
        let got = resolve_program("/usr/bin/docker", OsStr::new("/bin"));
        assert_eq!(got, OsString::from("/usr/bin/docker"));
    }

    #[test]
    fn resolve_program_unresolved_returns_name() {
        let got = resolve_program(
            "definitely-not-a-real-binary-xyz",
            OsStr::new("/bin:/usr/bin"),
        );
        assert_eq!(got, OsString::from("definitely-not-a-real-binary-xyz"));
    }

    #[cfg(unix)]
    #[test]
    fn parse_marker_line_extracts_last_marker() {
        let out = "motd line\n__VTERM_PATH__=/opt/homebrew/bin:/usr/bin\n";
        assert_eq!(
            parse_marker_line(out),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn parse_marker_line_none_without_marker() {
        assert_eq!(parse_marker_line("just some noise\n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn parse_marker_line_none_when_empty_value() {
        assert_eq!(parse_marker_line("__VTERM_PATH__=\n"), None);
    }
}
