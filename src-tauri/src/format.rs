//! Formatting a buffer with the project's own tool (ADR 0076).
//!
//! The editor sends the buffer and an argv it built (`format.ts`); this module
//! decides whether that argv may run at all — a known formatter, its stdin form,
//! nothing else — and how it runs where the file lives: over SSH in the file's
//! folder, or on this computer. A formatter reads stdin and prints the result;
//! `ansible-lint --fix` rewrites a file, so it gets a private copy beside the
//! original and the copy is read back and removed.

use serde::Serialize;

/// What a run of a formatter came back with.
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormatRun {
    /// False: the program is not installed where the file lives.
    pub found: bool,
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// How long a formatter may take; the fixer reads a whole project's rules.
pub const FORMAT_TIMEOUT: u64 = 30;
pub const FIX_TIMEOUT: u64 = 120;

/// Folders a non-login shell misses where people put their tools (`pip --user`,
/// `cargo install`, `go install`, Homebrew on Linux).
pub const TOOL_PATH: &str =
    "$HOME/.local/bin:$HOME/.cargo/bin:$HOME/go/bin:/usr/local/go/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH";

const EDITIONS: &[&str] = &["2015", "2018", "2021", "2024"];

/// A file name a tool is told: one plain token, never an option.
fn plain_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with('-')
        && !s.contains(['/', '\\', '\n', '\r', '\0'])
}

/// An absolute path a tool is told (prettier's `--stdin-filepath`).
fn plain_path(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 4096
        && (s.starts_with('/') || s.chars().nth(1) == Some(':') || s.starts_with("\\\\"))
        && !s.contains(['\n', '\r', '\0'])
}

/// Whether `argv` is one of the formatter forms the editor builds — and nothing
/// else: no other program, no option that reads or writes a file of its own.
pub fn check_args(argv: &[String]) -> Result<(), String> {
    let refuse = || Err(format!("not a formatter run: {}", argv.join(" ")));
    let Some((program, args)) = argv.split_first() else {
        return refuse();
    };
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let ok = match (program.as_str(), a.as_slice()) {
        ("ruff", ["format", "--stdin-filename", name, "-"]) => plain_name(name),
        ("black", ["-q", "--stdin-filename", name, "-"]) => plain_name(name),
        ("terraform" | "tofu", ["fmt", "-"]) => true,
        ("rustfmt", ["--emit", "stdout", "--edition", ed]) => EDITIONS.contains(ed),
        ("gofmt", []) => true,
        ("shfmt", ["-filename", name]) => plain_name(name),
        ("yamlfmt", ["-in"]) => true,
        ("prettier", ["--stdin-filepath", path]) => plain_path(path),
        ("xmllint", ["--format", "-"]) => true,
        ("clang-format", [opt]) => opt
            .strip_prefix("--assume-filename=")
            .is_some_and(plain_name),
        ("ansible-lint", ["--fix"]) => true,
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        refuse()
    }
}

/// Whether the run rewrites a file rather than printing (`ansible-lint --fix`).
pub fn is_fixer(argv: &[String]) -> bool {
    argv.first().is_some_and(|p| p == "ansible-lint")
}

/// The folder a formatter runs in: absolute and one line.
pub fn check_dir(dir: &str) -> Result<(), String> {
    if plain_path(dir) {
        Ok(())
    } else {
        Err(format!("not a folder to format in: {dir}"))
    }
}

/// The remote command: into the file's folder, the user's tool folders on
/// `PATH`, the argv quoted token by token. `file` replaces nothing — a fixer
/// gets its copy's path appended by the caller.
pub fn remote_command(dir: &str, argv: &[String]) -> String {
    let quoted: Vec<String> = argv.iter().map(|a| crate::git::shell_quote(a)).collect();
    format!(
        "cd {} && PATH=\"{TOOL_PATH}\" {}",
        crate::git::shell_quote(dir),
        quoted.join(" ")
    )
}

/// A run that never started because the program is missing: a shell's 127, or
/// the shell saying so.
pub fn not_found(code: i32, stderr: &str) -> bool {
    code == 127
        || (code != 0 && {
            let s = stderr.to_ascii_lowercase();
            s.contains("command not found") || s.contains(": not found")
        })
}

/// The copy a fixer works on, beside the original so the project's config and
/// roles resolve: hidden, unique, the original's extension kept.
pub fn fixer_copy(dir: &str, name: &str, unique: &str) -> String {
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("yml");
    let ext = if ext.chars().all(|c| c.is_ascii_alphanumeric()) && ext.len() <= 8 {
        ext
    } else {
        "yml"
    };
    let sep = if dir.contains('\\') && !dir.contains('/') {
        '\\'
    } else {
        '/'
    };
    format!(
        "{}{sep}.vterm-fix-{unique}.{ext}",
        dir.trim_end_matches(['/', '\\'])
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn what_the_editor_formats_with_is_allowed() {
        for argv in [
            v(&["ruff", "format", "--stdin-filename", "app.py", "-"]),
            v(&["black", "-q", "--stdin-filename", "app.py", "-"]),
            v(&["terraform", "fmt", "-"]),
            v(&["tofu", "fmt", "-"]),
            v(&["rustfmt", "--emit", "stdout", "--edition", "2021"]),
            v(&["gofmt"]),
            v(&["shfmt", "-filename", "deploy.sh"]),
            v(&["yamlfmt", "-in"]),
            v(&["prettier", "--stdin-filepath", "/srv/app/x.ts"]),
            v(&["prettier", "--stdin-filepath", "C:\\work\\x.ts"]),
            v(&["xmllint", "--format", "-"]),
            v(&["clang-format", "--assume-filename=main.c"]),
            v(&["ansible-lint", "--fix"]),
        ] {
            assert_eq!(check_args(&argv), Ok(()), "{argv:?}");
        }
    }

    #[test]
    fn nothing_else_runs_under_the_name_of_formatting() {
        for argv in [
            v(&[]),
            v(&["sh", "-c", "id"]),
            v(&["ruff", "check", "--fix", "."]),
            v(&["ruff", "format", "--stdin-filename", "--config=/etc/x", "-"]),
            v(&["ruff", "format", "--stdin-filename", "../../x.py", "-"]),
            v(&["terraform", "fmt", "-recursive"]),
            v(&["rustfmt", "--emit", "files", "--edition", "2021"]),
            v(&["rustfmt", "--emit", "stdout", "--edition", "1999"]),
            v(&["gofmt", "-w", "main.go"]),
            v(&["prettier", "--write", "."]),
            v(&["prettier", "--stdin-filepath", "relative.ts"]),
            v(&["prettier", "--stdin-filepath", "/a\nb"]),
            v(&["clang-format", "-i", "main.c"]),
            v(&["clang-format", "--assume-filename=-i"]),
            v(&["ansible-lint", "--fix", "/etc/passwd"]),
            v(&["yamlfmt", "-in", "-conf", "/x"]),
        ] {
            assert!(check_args(&argv).is_err(), "{argv:?}");
        }
    }

    #[test]
    fn the_command_quotes_every_token_and_runs_in_the_folder() {
        let cmd = remote_command(
            "/srv/my app",
            &v(&["ruff", "format", "--stdin-filename", "a b.py", "-"]),
        );
        assert_eq!(
            cmd,
            format!("cd '/srv/my app' && PATH=\"{TOOL_PATH}\" 'ruff' 'format' '--stdin-filename' 'a b.py' '-'")
        );
        assert!(check_dir("/srv").is_ok());
        assert!(check_dir("srv").is_err());
        assert!(check_dir("/a\nb").is_err());
    }

    #[test]
    fn a_missing_program_is_told_from_a_failed_one() {
        assert!(not_found(127, ""));
        assert!(not_found(1, "sh: 1: ruff: not found"));
        assert!(not_found(1, "bash: ruff: command not found"));
        assert!(!not_found(2, "error: Failed to parse app.py:1:5"));
        assert!(!not_found(0, "not found"));
    }

    #[test]
    fn the_fixer_works_on_a_hidden_copy_beside_the_file() {
        assert_eq!(
            fixer_copy("/srv/pb", "site.yml", "ab12"),
            "/srv/pb/.vterm-fix-ab12.yml"
        );
        assert_eq!(
            fixer_copy("/srv/pb/", "x.yaml", "1"),
            "/srv/pb/.vterm-fix-1.yaml"
        );
        assert_eq!(
            fixer_copy("C:\\pb", "x.yml", "1"),
            "C:\\pb\\.vterm-fix-1.yml"
        );
        assert_eq!(fixer_copy("/srv", "noext", "1"), "/srv/.vterm-fix-1.yml");
        assert!(is_fixer(&v(&["ansible-lint", "--fix"])));
        assert!(!is_fixer(&v(&["ruff"])));
    }
}
