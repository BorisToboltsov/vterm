// Scenarios (ADR 0071, 0072): the user's recipes — shell scripts with a
// `# vterm:` header — and playbooks of Ansible, and the projects of Ansible and
// Terraform that live in a folder of a session. Three things live here, each
// pure where it can be:
//
// - the library on this computer: the recipes folder in the app's data
//   directory and whatever folders the user added as sources (read only) — their
//   scripts and playbooks, and the folders in a source that may be projects;
// - how a recipe reaches a server: the fixed wrapper a session's exec channel
//   runs, with the script and the sudo password on stdin — never on a command
//   line, never in a file the wrapper does not remove;
// - what the Ansible and Terraform checks of a project may run (the policy
//   behind the WebView, ADR 0036) and the temporary folder a run of Ansible or
//   a plan of Terraform keeps its files in, on the host where the project is.
//
// `ansible-playbook`, `terraform plan` and `terraform apply` themselves are typed
// into the tab's terminal (the user's programs, in the user's shell): the
// backend never runs them.

use crate::diag::Logged;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// The largest recipe or playbook the library reads: a script, not a payload.
pub const MAX_RECIPE_BYTES: u64 = 64 * 1024;
/// How many files one folder may give the library.
pub const MAX_RECIPES_PER_DIR: usize = 300;
/// What the library reads: shell scripts (recipes) and YAML (playbooks — the
/// window tells a playbook from other YAML, ADR 0072).
pub const LIBRARY_EXTENSIONS: [&str; 3] = ["sh", "yml", "yaml"];
/// How many folders of one source are listed for the window to tell a project by.
pub const MAX_FOLDERS_PER_SOURCE: usize = 100;
/// How many names of one such folder are listed.
pub const MAX_LISTING: usize = 200;
/// The longest a recipe may run, whatever the window asks for.
pub const MAX_RUN_SECS: u64 = 3600;
/// The name every temporary folder of a project run starts with — the only
/// folders `iac_read` reads and `iac_cleanup` removes.
pub const TEMP_MARK: &str = "vterm-iac.";
/// The most `iac_read` hands over at once.
pub const READ_CHUNK: u64 = 256 * 1024;
/// The largest file a project run may place in its temporary folder.
pub const MAX_TEMP_FILE: usize = 1024 * 1024;

/// The recipes folder in the app's data directory — the "Mine" of the library.
pub fn recipes_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("su", "vcore", "vterm").map(|d| d.data_dir().join("scripts"))
}

/// One recipe file the library read.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecipeFile {
    pub path: String,
    /// The folder it was found in, as the library names its source.
    pub dir: String,
    pub name: String,
    pub text: String,
    /// Modification time, epoch seconds (0 when the OS would not say).
    pub modified: u64,
}

/// One name in a folder's listing.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListedName {
    pub name: String,
    pub is_dir: bool,
}

/// A folder of a source — the source itself or one folder in it — with its
/// names, for the window to tell whether it is a project (`projectSigns`).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFolder {
    pub path: String,
    /// The source it was found in.
    pub source: String,
    pub entries: Vec<ListedName>,
}

/// What a scan of the library found.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecipeScan {
    /// The app's own recipes folder (created on first save).
    pub dir: String,
    pub files: Vec<RecipeFile>,
    /// Each source and the folders in it, listed (not the app's own folder).
    pub folders: Vec<SourceFolder>,
    /// Sources that could not be read — named, never shown as empty (principle 5).
    pub unreadable: Vec<String>,
    /// Files skipped: too large, not text, or past the most a folder is read for.
    pub skipped: usize,
}

fn mtime(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

/// Whether a file name is one the library reads.
pub fn is_library_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| LIBRARY_EXTENSIONS.contains(&x))
}

/// The names of `dir`, folders marked, hidden ones left out; at most
/// [`MAX_LISTING`]. None when it cannot be read.
fn listing(dir: &Path) -> Option<Vec<ListedName>> {
    let mut out: Vec<ListedName> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().ok()?.is_dir();
            Some(ListedName { name, is_dir })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.truncate(MAX_LISTING);
    Some(out)
}

/// A source and the folders in it (one level, not hidden), listed: a source may
/// be a project itself, or hold projects — the window tells which.
fn scan_folders(source: &Path, scan: &mut RecipeScan) {
    let shown = source.to_string_lossy().into_owned();
    let Some(top) = listing(source) else {
        return;
    };
    let subs: Vec<String> = top
        .iter()
        .filter(|e| e.is_dir && !e.name.starts_with('.'))
        .map(|e| e.name.clone())
        .take(MAX_FOLDERS_PER_SOURCE)
        .collect();
    scan.folders.push(SourceFolder {
        path: shown.clone(),
        source: shown.clone(),
        entries: top,
    });
    for name in subs {
        let path = source.join(&name);
        if let Some(entries) = listing(&path) {
            scan.folders.push(SourceFolder {
                path: path.to_string_lossy().into_owned(),
                source: shown.clone(),
                entries,
            });
        }
    }
}

/// Read the scripts and YAML files of `dir` (not its subfolders) into `scan`. A
/// folder that does not exist is no error for the app's own one — nothing was
/// saved yet.
fn scan_dir(dir: &Path, own: bool, scan: &mut RecipeScan) {
    let shown = dir.to_string_lossy().into_owned();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if own && e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            tracing::warn!(source = "scenarios", dir = %shown, "a recipe folder was not read: {e}");
            scan.unreadable.push(shown);
            return;
        }
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| is_library_name(n) && !n.starts_with('.'))
        })
        .collect();
    paths.sort();
    scan.skipped += paths.len().saturating_sub(MAX_RECIPES_PER_DIR);
    for path in paths.into_iter().take(MAX_RECIPES_PER_DIR) {
        let Ok(meta) = std::fs::metadata(&path) else {
            scan.skipped += 1;
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_RECIPE_BYTES {
            scan.skipped += 1;
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            scan.skipped += 1;
            continue;
        };
        let Ok(text) = String::from_utf8(bytes) else {
            scan.skipped += 1;
            continue;
        };
        scan.files.push(RecipeFile {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            dir: shown.clone(),
            text,
            modified: mtime(&meta),
        });
    }
}

/// Read the library: the app's own folder first, then each source the user
/// added. A source given twice, or the app's own folder named again, is read once.
pub fn scan(own: &Path, sources: &[String]) -> RecipeScan {
    let mut out = RecipeScan {
        dir: own.to_string_lossy().into_owned(),
        ..RecipeScan::default()
    };
    scan_dir(own, true, &mut out);
    let mut seen = vec![own.to_path_buf()];
    for s in sources {
        let p = PathBuf::from(s);
        if s.trim().is_empty() || !p.is_absolute() || seen.contains(&p) {
            continue;
        }
        seen.push(p.clone());
        scan_dir(&p, false, &mut out);
        if !out.unreadable.contains(s) {
            scan_folders(&p, &mut out);
        }
    }
    out
}

/// The library: the app's recipes and those of the folders the user added.
#[tauri::command]
pub fn recipes_scan(sources: Vec<String>) -> AppResult<RecipeScan> {
    let own = recipes_dir().ok_or_else(|| AppError::Message("no data directory".into()))?;
    let out = scan(&own, &sources);
    tracing::debug!(
        source = "scenarios",
        files = out.files.len(),
        folders = out.folders.len(),
        sources = sources.len(),
        unreadable = out.unreadable.len(),
        "the recipe library was read"
    );
    Ok(out)
}

/// The file name a recipe or a playbook is saved under: one path component
/// ending in `.sh`, `.yml` or `.yaml`, not hidden.
pub fn library_file_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    let stem = name.rsplit_once('.').map_or("", |(stem, _)| stem);
    if !is_library_name(name) || stem.is_empty() || name.starts_with('.') {
        return Err(AppError::Message(format!(
            "not a file name of the library: {name}"
        )));
    }
    crate::localfile::safe_child(Path::new("."), name)?;
    Ok(name.to_string())
}

/// Write a recipe into `dir` — staged next to it and renamed over, like every
/// other write: a failed save leaves the old recipe as it was. Without `replace`
/// a taken name is `dest-exists`.
pub fn save_in(dir: &Path, name: &str, text: &str, replace: bool) -> AppResult<PathBuf> {
    let name = library_file_name(name)?;
    if text.len() as u64 > MAX_RECIPE_BYTES {
        return Err(AppError::Message("the recipe is larger than 64 KB".into()));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::Message(format!("create the recipes folder: {e}")))?;
    let path = crate::localfile::safe_child(dir, &name)?;
    if !replace && path.exists() {
        return Err(AppError::DestinationExists);
    }
    let tmp = dir.join(format!(".{name}.vterm-tmp"));
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| AppError::Message(format!("write the recipe: {e}")))?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        std::fs::remove_file(&tmp).log_debug("scenarios", "a staged recipe was not removed");
        return Err(AppError::Message(format!("write the recipe: {e}")));
    }
    Ok(path)
}

/// Save a recipe or a playbook into the app's recipes folder; its path.
#[tauri::command]
pub fn recipe_save(name: String, text: String, replace: bool) -> AppResult<String> {
    let dir = recipes_dir().ok_or_else(|| AppError::Message("no data directory".into()))?;
    let path = save_in(&dir, &name, &text, replace)?;
    tracing::info!(source = "scenarios", name = %name, replace, "a recipe was saved");
    Ok(path.to_string_lossy().into_owned())
}

/// Whether `path` is a file of the app's own folder the library reads — the
/// only ones the app deletes; a source folder is the user's, and stays as it is.
pub fn is_own_recipe(own: &Path, path: &Path) -> bool {
    path.parent() == Some(own)
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| crate::localfile::safe_component(n) && is_library_name(n))
}

/// Delete a recipe or a playbook of the app's own folder.
#[tauri::command]
pub fn recipe_delete(path: String) -> AppResult<()> {
    let own = recipes_dir().ok_or_else(|| AppError::Message("no data directory".into()))?;
    let p = PathBuf::from(&path);
    if !is_own_recipe(&own, &p) {
        return Err(AppError::Message(format!(
            "not a recipe of the library: {path}"
        )));
    }
    std::fs::remove_file(&p).map_err(|e| AppError::Message(format!("delete the recipe: {e}")))?;
    tracing::info!(source = "scenarios", path = %path, "a recipe was deleted");
    Ok(())
}

// ── How a recipe reaches a server ─────────────────────────────────────────────

/// Who a recipe runs as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Elevation {
    /// The login of the connection.
    User,
    /// `sudo`, without a password (`-n`: a sudo that asks fails at once).
    Sudo,
    /// `sudo -S`, its password the first line of stdin.
    SudoPassword,
}

/// The command a session's exec channel runs for a recipe. Fixed text: the
/// script and the password come on stdin, so nothing of them reaches a command
/// line (`ps`) or the server's logs of commands. The script is written to a
/// private temporary file (`umask 077`) that the wrapper removes however it
/// ends, and run from there with stdin closed — a command of the script that
/// reads stdin would otherwise eat the rest of the script. Exit 125 is the
/// wrapper's own failure. Wrapped in `sh -c` whatever the login shell is (fish).
pub fn run_command(elevation: Elevation) -> String {
    let run = match elevation {
        Elevation::User => r#"sh "$f" </dev/null"#,
        Elevation::Sudo => r#"sudo -n -- sh "$f" </dev/null"#,
        Elevation::SudoPassword => r#"printf '%s\n' "$p" | sudo -S -p '' -- sh "$f""#,
    };
    let read_password = if elevation == Elevation::SudoPassword {
        "IFS= read -r p || exit 125; "
    } else {
        ""
    };
    let body = format!(
        "umask 077; {read_password}f=$(mktemp) || exit 125; trap 'rm -f \"$f\"' EXIT; cat >\"$f\" || exit 125; {run}"
    );
    format!("sh -c {}", crate::git::shell_quote(&body))
}

/// What a recipe run writes to stdin: the sudo password's line (when asked to
/// use one), then the script. Zeroed when dropped.
pub fn run_stdin(
    elevation: Elevation,
    password: Option<&str>,
    script: &str,
) -> AppResult<Zeroizing<Vec<u8>>> {
    let mut out = Zeroizing::new(Vec::with_capacity(script.len() + 64));
    if elevation == Elevation::SudoPassword {
        let pw = password
            .filter(|p| !p.is_empty())
            .ok_or_else(|| AppError::Message("sudo with a password needs the password".into()))?;
        if pw.contains(['\n', '\r']) {
            return Err(AppError::Message(
                "a password cannot hold a line break".into(),
            ));
        }
        out.extend_from_slice(pw.as_bytes());
        out.push(b'\n');
    }
    out.extend_from_slice(script.as_bytes());
    Ok(out)
}

// ── Ansible and Terraform: what the checks of a project may run ───────────────

/// A path the policy lets through as an argument: absolute, no `..`, and not
/// an option in disguise.
fn plain_path(p: &str) -> bool {
    p.starts_with('/')
        && !p.starts_with("--")
        && !p.split('/').any(|s| s == "..")
        && !p.contains('\0')
}

/// Which argv the checks of a project may run (ADR 0071): reading what a
/// project is, never running it. `ansible-playbook` and `terraform plan/apply`
/// are typed into the terminal by the user's action — through here they never go.
pub fn check_iac_args(args: &[String]) -> Result<(), String> {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["ansible-playbook" | "ansible" | "ansible-inventory", "--version"] => Ok(()),
        ["ansible-galaxy", "collection", "list", "--format", "json"] => Ok(()),
        ["terraform", "version", "-json"] => Ok(()),
        ["ansible-inventory", "--list", rest @ ..] => {
            // `-i <path>` pairs only: an inventory read is all this call may do.
            if rest.is_empty() || rest.len() % 2 != 0 {
                return Err("ansible-inventory takes -i <path> pairs".into());
            }
            for pair in rest.chunks(2) {
                if pair[0] != "-i" || !plain_path(pair[1]) {
                    return Err(format!(
                        "ansible-inventory: {} is not allowed",
                        pair.join(" ")
                    ));
                }
            }
            Ok(())
        }
        ["terraform", chdir, "show", "-json", plan] => {
            let dir = chdir
                .strip_prefix("-chdir=")
                .ok_or_else(|| "terraform show runs in its project (-chdir=)".to_string())?;
            if !plain_path(dir) {
                return Err(format!("terraform: {chdir} is not a project folder"));
            }
            // A saved plan of a run, never a state file: `show` of a state prints
            // every secret in it.
            if !plain_path(plan) || !plan.ends_with(".tfplan") || !is_temp_path(plan) {
                return Err(format!("terraform show reads only a plan of a run: {plan}"));
            }
            Ok(())
        }
        _ => Err(format!("{} is not a check of a project", a.join(" "))),
    }
}

/// The environment of a check: no colours, no questions, and the project's
/// `ansible.cfg` when there is one.
pub fn iac_env(config: Option<&str>) -> AppResult<Vec<(String, String)>> {
    let mut env = vec![
        ("ANSIBLE_NOCOLOR".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
        ("TF_IN_AUTOMATION".to_string(), "1".to_string()),
        ("TF_INPUT".to_string(), "0".to_string()),
    ];
    if let Some(cfg) = config {
        if !plain_path(cfg) || !cfg.ends_with("/ansible.cfg") {
            return Err(AppError::Message(format!("not an ansible.cfg: {cfg}")));
        }
        env.push(("ANSIBLE_CONFIG".to_string(), cfg.to_string()));
    }
    Ok(env)
}

/// The command line an SSH tab runs for a check: the environment through `env`,
/// every token quoted.
pub fn iac_remote_command(env: &[(String, String)], args: &[String]) -> String {
    let mut argv = vec!["env".to_string()];
    argv.extend(env.iter().map(|(k, v)| format!("{k}={v}")));
    argv.extend(args.iter().cloned());
    crate::exec::remote_command(&argv)
}

// ── The temporary folder of a run ─────────────────────────────────────────────

/// Whether `path` lies in a temporary folder of a project run: some component
/// names it, and nothing climbs out of it.
pub fn is_temp_path(path: &str) -> bool {
    let unix = path.replace('\\', "/");
    let absolute = unix.starts_with('/') || unix.get(1..3) == Some(":/");
    absolute
        && !unix.split('/').any(|s| s == ".." || s == ".")
        && unix
            .split('/')
            .any(|s| s.starts_with(TEMP_MARK) && s.len() > TEMP_MARK.len())
}

/// One file a run places in its temporary folder.
#[derive(Deserialize, Debug)]
pub struct TempFile {
    pub name: String,
    pub text: String,
}

/// A file's name in the temporary folder: one safe component.
pub fn temp_file_name(name: &str) -> AppResult<&str> {
    if !crate::localfile::safe_component(name) {
        return Err(AppError::Message(format!("not a file name: {name}")));
    }
    Ok(name)
}

/// The shell of an SSH tab that makes the temporary folder and prints its path.
pub const REMOTE_MKTEMP: &str = r#"sh -c 'umask 077; d=$(mktemp -d "${TMPDIR:-/tmp}/vterm-iac.XXXXXX") || exit 1; printf %s "$d"'"#;

/// The shell of an SSH tab that writes stdin into one file of the folder.
pub fn remote_write(path: &str) -> String {
    format!(
        "sh -c 'umask 077; cat > \"$1\"' sh {}",
        crate::git::shell_quote(path)
    )
}

/// The shell of an SSH tab that reads a file of the folder from `offset`: the
/// size on the first line, then up to [`READ_CHUNK`] bytes. Exit 3 — no file.
pub fn remote_read(path: &str, offset: u64) -> String {
    format!(
        "sh -c '[ -f \"$1\" ] || exit 3; wc -c < \"$1\"; tail -c +$(($2 + 1)) \"$1\" | head -c {READ_CHUNK}' sh {} {offset}",
        crate::git::shell_quote(path)
    )
}

/// The shell of an SSH tab that removes the folder — only a folder of a run.
pub fn remote_cleanup(dir: &str) -> String {
    format!(
        "sh -c 'case \"$1\" in *{TEMP_MARK}*) rm -rf -- \"$1\";; *) exit 2;; esac' sh {}",
        crate::git::shell_quote(dir)
    )
}

/// A chunk of a file of a run: whether it exists, its size, and the whole lines
/// from the offset asked for — a line still being written waits for the next
/// read, so a character is never cut in two. `read` is how many bytes those
/// lines take: the next read starts after them.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TempChunk {
    pub exists: bool,
    pub size: u64,
    pub text: String,
    pub read: u64,
}

/// `text` cut after its last line break; the bytes kept.
fn whole_lines(text: &str) -> (String, u64) {
    match text.rfind('\n') {
        Some(i) => (text[..=i].to_string(), (i + 1) as u64),
        None => (String::new(), 0),
    }
}

/// Read the answer of [`remote_read`].
pub fn parse_remote_read(exit: i32, stdout: &str) -> AppResult<TempChunk> {
    if exit == 3 {
        return Ok(TempChunk::default());
    }
    if exit != 0 {
        return Err(AppError::Message(format!(
            "the file of the run was not read (exit {exit})"
        )));
    }
    let (first, rest) = stdout.split_once('\n').unwrap_or((stdout, ""));
    let size = first
        .trim()
        .parse::<u64>()
        .map_err(|_| AppError::Message("the size of the file of the run was not read".into()))?;
    let (text, read) = whole_lines(rest);
    Ok(TempChunk {
        exists: true,
        size,
        text,
        read,
    })
}

/// Make a temporary folder on this computer, private to the user.
pub fn local_mktemp() -> AppResult<PathBuf> {
    // `tempfile` makes it in the system's temporary directory, 0700 on Unix,
    // under a name nobody holds; kept, the run removes it (`iac_cleanup`).
    tempfile::Builder::new()
        .prefix(TEMP_MARK)
        .tempdir()
        .map(|d| d.keep())
        .map_err(|e| AppError::Message(format!("make the folder of the run: {e}")))
}

/// Write one file into a local folder of a run, readable by the user alone.
pub fn local_write(dir: &Path, file: &TempFile) -> AppResult<()> {
    use std::io::Write;
    let path = dir.join(temp_file_name(&file.name)?);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(&path)
        .map_err(|e| AppError::Message(format!("write {}: {e}", file.name)))?;
    f.write_all(file.text.as_bytes())
        .map_err(|e| AppError::Message(format!("write {}: {e}", file.name)))
}

/// Read a local file of a run from `offset`.
pub fn local_read(path: &Path, offset: u64) -> AppResult<TempChunk> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TempChunk::default()),
        Err(e) => return Err(AppError::Message(format!("read the file of the run: {e}"))),
    };
    let size = f
        .metadata()
        .map_err(|e| AppError::Message(format!("read the file of the run: {e}")))?
        .len();
    let mut buf = Vec::new();
    if offset < size {
        f.seek(SeekFrom::Start(offset))
            .map_err(|e| AppError::Message(format!("read the file of the run: {e}")))?;
        f.take(READ_CHUNK)
            .read_to_end(&mut buf)
            .map_err(|e| AppError::Message(format!("read the file of the run: {e}")))?;
    }
    // Cut at the last line break in the bytes: what is before it is whole.
    let end = buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    Ok(TempChunk {
        exists: true,
        size,
        text: String::from_utf8_lossy(&buf[..end]).into_owned(),
        read: end as u64,
    })
}

/// Whether a local folder may be removed as a folder of a run: it is one, and
/// it lies directly in this computer's temporary directory.
pub fn local_removable(dir: &Path) -> bool {
    // Only compared with, never created in: the folder itself was made by
    // `tempfile` under a name nobody held (`local_mktemp`).
    // nosemgrep: rust.lang.security.temp-dir.temp-dir
    let tmp = std::env::temp_dir();
    is_temp_path(&dir.to_string_lossy())
        && dir.parent() == Some(tmp.as_path())
        && dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(TEMP_MARK))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn what_the_checks_of_a_project_run_is_allowed() {
        for ok in [
            s(&["ansible-playbook", "--version"]),
            s(&["ansible-galaxy", "collection", "list", "--format", "json"]),
            s(&[
                "ansible-inventory",
                "--list",
                "-i",
                "/srv/infra/inventory/prod.ini",
            ]),
            s(&[
                "ansible-inventory",
                "--list",
                "-i",
                "/a/hosts",
                "-i",
                "/tmp/vterm-iac.abc/vterm.yml",
            ]),
            s(&["terraform", "version", "-json"]),
            s(&[
                "terraform",
                "-chdir=/srv/tf",
                "show",
                "-json",
                "/tmp/vterm-iac.x1/plan.tfplan",
            ]),
        ] {
            assert_eq!(check_iac_args(&ok), Ok(()), "{ok:?}");
        }
        for bad in [
            s(&["ansible-playbook", "site.yml"]),
            s(&["ansible", "all", "-m", "shell", "-a", "rm -rf /"]),
            s(&["ansible-inventory", "--list"]),
            s(&["ansible-inventory", "--list", "-i", "hosts"]),
            s(&["ansible-inventory", "--list", "-i", "/a/../etc/x"]),
            s(&["ansible-inventory", "--list", "--vault-password-file", "/x"]),
            s(&[
                "ansible-galaxy",
                "collection",
                "install",
                "community.general",
            ]),
            s(&["terraform", "apply", "-auto-approve"]),
            s(&["terraform", "-chdir=/srv/tf", "show", "-json"]),
            s(&[
                "terraform",
                "-chdir=/srv/tf",
                "show",
                "-json",
                "/srv/tf/terraform.tfstate",
            ]),
            s(&[
                "terraform",
                "-chdir=/srv/tf",
                "show",
                "-json",
                "/srv/tf/plan.tfplan",
            ]),
            s(&["terraform", "show", "-json", "/tmp/vterm-iac.x/plan.tfplan"]),
            s(&["sh", "-c", "id"]),
        ] {
            assert!(check_iac_args(&bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_recipes_script_and_password_never_reach_a_command_line() {
        for e in [Elevation::User, Elevation::Sudo, Elevation::SudoPassword] {
            let cmd = run_command(e);
            // Fixed text: nothing of the run is in it.
            assert!(cmd.starts_with("sh -c '"), "{cmd}");
            assert!(cmd.contains("umask 077") && cmd.contains("rm -f"), "{cmd}");
            assert!(!cmd.contains("hunter2"));
        }
        assert!(run_command(Elevation::Sudo).contains("sudo -n --"));
        assert!(run_command(Elevation::SudoPassword).contains("sudo -S -p"));
        let stdin = run_stdin(Elevation::SudoPassword, Some("hunter2"), "echo hi\n").unwrap();
        assert_eq!(&stdin[..], b"hunter2\necho hi\n");
        assert_eq!(
            &run_stdin(Elevation::Sudo, Some("hunter2"), "x").unwrap()[..],
            b"x"
        );
        assert!(run_stdin(Elevation::SudoPassword, None, "x").is_err());
        assert!(run_stdin(Elevation::SudoPassword, Some("a\nb"), "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_wrapper_runs_the_script_from_stdin_and_leaves_no_file() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let cmd = run_command(Elevation::User);
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .env("TMPDIR", dir.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        // `cat` in the script would read the rest of the script if stdin were open.
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"cat; echo \"ran:$VTERM_MODE\"\nexit 7\n")
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert_eq!(out.status.code(), Some(7));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ran:\n");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "the script file is removed"
        );
    }

    #[test]
    fn the_library_reads_scripts_and_yaml_and_names_what_it_could_not() {
        let own = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        std::fs::write(own.path().join("b.sh"), "# b").unwrap();
        std::fs::write(own.path().join("a.sh"), "# a").unwrap();
        std::fs::write(own.path().join("nginx.yml"), "- hosts: all").unwrap();
        std::fs::write(own.path().join("notes.txt"), "x").unwrap();
        std::fs::write(own.path().join(".hidden.yml"), "x").unwrap();
        std::fs::write(
            src.path().join("big.sh"),
            vec![b'x'; MAX_RECIPE_BYTES as usize + 1],
        )
        .unwrap();
        std::fs::write(src.path().join("bin.sh"), [0xff, 0xfe, 0x00]).unwrap();
        let missing = src.path().join("gone").to_string_lossy().into_owned();
        let out = scan(
            own.path(),
            &[
                src.path().to_string_lossy().into_owned(),
                missing.clone(),
                "relative".into(),
            ],
        );
        let names: Vec<_> = out.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["a.sh", "b.sh", "nginx.yml"]);
        assert_eq!(out.skipped, 2);
        assert_eq!(out.unreadable, [missing]);
        // The app's own folder before anything is saved: nothing, and no complaint.
        let fresh = scan(&own.path().join("none"), &[]);
        assert!(fresh.files.is_empty() && fresh.unreadable.is_empty());
    }

    #[test]
    fn files_past_the_most_a_folder_is_read_for_are_counted_not_dropped() {
        let own = tempfile::tempdir().unwrap();
        for i in 0..MAX_RECIPES_PER_DIR + 3 {
            std::fs::write(own.path().join(format!("r{i:04}.sh")), "# r").unwrap();
        }
        let out = scan(own.path(), &[]);
        assert_eq!(out.files.len(), MAX_RECIPES_PER_DIR);
        assert_eq!(out.skipped, 3);
    }

    #[test]
    fn a_source_and_its_folders_are_listed_for_the_window_to_tell_a_project() {
        let src = tempfile::tempdir().unwrap();
        let infra = src.path().join("infra");
        std::fs::create_dir_all(infra.join("roles")).unwrap();
        std::fs::write(infra.join("site.yml"), "- hosts: all").unwrap();
        std::fs::create_dir_all(src.path().join(".git")).unwrap();
        std::fs::write(src.path().join("deploy.yml"), "- hosts: all").unwrap();
        let own = tempfile::tempdir().unwrap();
        let out = scan(own.path(), &[src.path().to_string_lossy().into_owned()]);
        let paths: Vec<_> = out.folders.iter().map(|f| f.path.clone()).collect();
        let root = src.path().to_string_lossy().into_owned();
        // The source itself and its folders — hidden ones not.
        assert_eq!(paths, [root.clone(), infra.to_string_lossy().into_owned()]);
        assert!(out.folders.iter().all(|f| f.source == root));
        assert_eq!(
            out.folders[1].entries,
            [
                ListedName {
                    name: "roles".into(),
                    is_dir: true
                },
                ListedName {
                    name: "site.yml".into(),
                    is_dir: false
                },
            ]
        );
        // The app's own folder is the library's, never a project's.
        assert!(scan(own.path(), &[]).folders.is_empty());
    }

    #[test]
    fn a_recipe_is_saved_whole_and_a_taken_name_is_asked_about() {
        let dir = tempfile::tempdir().unwrap();
        let p = save_in(dir.path(), "x.sh", "one", false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "one");
        assert!(matches!(
            save_in(dir.path(), "x.sh", "two", false),
            Err(AppError::DestinationExists)
        ));
        save_in(dir.path(), "x.sh", "two", true).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        let book = save_in(dir.path(), "web.yml", "- hosts: all", false).unwrap();
        for bad in [
            "../x.sh",
            "x.txt",
            ".sh",
            ".hidden.sh",
            "a/b.sh",
            ".yml",
            "x.json",
        ] {
            assert!(save_in(dir.path(), bad, "x", false).is_err(), "{bad}");
        }
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            2,
            "no staged file left"
        );
        assert!(is_own_recipe(dir.path(), &p));
        assert!(is_own_recipe(dir.path(), &book));
        assert!(!is_own_recipe(
            dir.path(),
            &dir.path().join("sub").join("x.sh")
        ));
        assert!(!is_own_recipe(dir.path(), &dir.path().join("x.txt")));
    }

    #[test]
    fn only_a_folder_of_a_run_is_read_or_removed() {
        assert!(is_temp_path("/tmp/vterm-iac.AbC123/events.log"));
        assert!(is_temp_path("/tmp/vterm-iac.AbC123"));
        assert!(is_temp_path(
            "C:\\Users\\a\\AppData\\Local\\Temp\\vterm-iac.x\\plan.tfplan"
        ));
        for bad in [
            "/tmp/vterm-iac./x",
            "/etc/passwd",
            "tmp/vterm-iac.a/x",
            "/tmp/vterm-iac.a/../../etc/passwd",
            "/tmp/vterm-iac.a/./x",
        ] {
            assert!(!is_temp_path(bad), "{bad}");
        }
        assert!(remote_cleanup("/tmp/vterm-iac.a").contains("*vterm-iac.*) rm -rf"));
        let dir = local_mktemp().unwrap();
        assert!(local_removable(&dir));
        assert!(!local_removable(Path::new("/tmp")));
        local_write(
            &dir,
            &TempFile {
                name: "e.log".into(),
                text: "ab\ncdé\nf".into(),
            },
        )
        .unwrap();
        assert!(local_write(
            &dir,
            &TempFile {
                name: "../x".into(),
                text: String::new()
            }
        )
        .is_err());
        let chunk = local_read(&dir.join("e.log"), 3).unwrap();
        // The line still being written ("f") waits; the bytes of what was given are counted.
        assert_eq!(
            chunk,
            TempChunk {
                exists: true,
                size: 9,
                text: "cdé\n".into(),
                read: 5
            }
        );
        assert_eq!(
            local_read(&dir.join("none"), 0).unwrap(),
            TempChunk::default()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_remote_read_answers_its_size_then_its_text() {
        assert_eq!(parse_remote_read(3, "").unwrap(), TempChunk::default());
        assert_eq!(
            parse_remote_read(0, "  12\n{\"a\":1}\n{\"b\"").unwrap(),
            TempChunk {
                exists: true,
                size: 12,
                text: "{\"a\":1}\n".into(),
                read: 8
            }
        );
        assert_eq!(parse_remote_read(0, "5\nno break").unwrap().read, 0);
        assert!(parse_remote_read(1, "").is_err());
        assert!(parse_remote_read(0, "x\n").is_err());
        assert!(remote_read("/tmp/vterm-iac.a/e", 5).ends_with("'/tmp/vterm-iac.a/e' 5"));
    }

    #[test]
    fn a_check_has_no_colours_and_only_a_projects_config() {
        let env = iac_env(Some("/srv/infra/ansible.cfg")).unwrap();
        assert!(env
            .iter()
            .any(|(k, v)| k == "ANSIBLE_CONFIG" && v == "/srv/infra/ansible.cfg"));
        assert!(iac_env(Some("/etc/passwd")).is_err());
        assert!(iac_env(Some("ansible.cfg")).is_err());
        let line = iac_remote_command(
            &iac_env(None).unwrap(),
            &s(&["terraform", "version", "-json"]),
        );
        assert!(
            line.starts_with("'env' 'ANSIBLE_NOCOLOR=1' 'NO_COLOR=1'"),
            "{line}"
        );
    }
}
