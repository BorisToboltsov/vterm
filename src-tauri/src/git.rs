// Git panel backend (Phase 29). A single thin executor runs `git` in a working
// directory and captures stdout/stderr/exit code — nothing more. All argument
// building and output parsing lives on the frontend (`src/lib/git.ts`), keeping
// this side dumb and testable-in-TS per the "pure logic in .ts" invariant.
//
// Two transports, one contract (like the terminal): SSH tabs run the command on
// a dedicated exec channel (`SshSession::exec_captured`, remote `git`); local
// shell tabs spawn `git` here via `tokio::process`. The command surface is the
// same either way — an argument vector executed inside `cwd`.
//
// `GIT_TERMINAL_PROMPT=0` is forced so credential prompts (HTTPS-with-password
// remotes over a non-TTY exec channel) fail fast with a readable error instead
// of hanging forever.

use crate::error::AppResult;
use serde::Serialize;
use std::time::Duration;

/// Captured result of one `git` invocation. Mirrors [`crate::ssh::ExecOutcome`]
/// minus `timed_out`, which is folded into a non-zero exit + stderr note.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// POSIX single-quote escaping so an argument survives the remote login shell
/// intact (SSH `exec` runs the string through the user's shell). Wraps in `'…'`
/// and rewrites embedded quotes as `'\''`.
pub fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Build the shell command string run on the remote for an SSH tab:
/// `GIT_TERMINAL_PROMPT=0 git -C '<cwd>' '<arg>' …`. Every field is quoted so
/// branch names, commit messages, paths, etc. can't break out of the command.
pub fn ssh_command(cwd: &str, args: &[String]) -> String {
    let mut cmd = format!("GIT_TERMINAL_PROMPT=0 git -C {}", shell_quote(cwd));
    for a in args {
        cmd.push(' ');
        cmd.push_str(&shell_quote(a));
    }
    cmd
}

/// Run `git -C <cwd> <args…>` locally, bounded by `timeout_secs`. No shell is
/// involved — args are passed to `git` verbatim, so no quoting is needed.
pub async fn run_local(cwd: &str, args: &[String], timeout_secs: u64) -> AppResult<GitOutput> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        // Terminate the child if we abandon it on timeout, so a stuck `git`
        // (e.g. a working-tree filter / LFS smudge waiting on the network) can't
        // linger and hold `.git/index.lock` for the next command.
        .kill_on_drop(true);

    let fut = command.output();
    let output = match tokio::time::timeout(Duration::from_secs(timeout_secs.max(1)), fut).await {
        Ok(res) => res.map_err(|e| format!("git failed to run: {e}"))?,
        Err(_) => {
            return Ok(GitOutput {
                stdout: String::new(),
                stderr: format!(
                    "git timed out after {timeout_secs}s — the working-tree update may be \
                     stuck on a filter (e.g. Git LFS) or a slow/unreachable remote"
                ),
                exit_code: -1,
            })
        }
    };

    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Render a mutating git-panel op for the session recording (audit): a magenta
/// `[git] $ <command>` header, the combined output (LF → CRLF so it doesn't
/// staircase on replay), and a `[git] exit N` footer. Mirrors `ai::agent_mirror`,
/// but recorded ONLY (never emitted to the live terminal).
pub fn git_mirror(command: &str, stdout: &str, stderr: &str, exit_code: i32) -> String {
    let body = format!("{stdout}{stderr}").replace('\n', "\r\n");
    format!(
        "\r\n\u{1b}[35m[git] $ {command}\u{1b}[0m\r\n{body}\r\n\u{1b}[35m[git] exit {exit_code}\u{1b}[0m\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_mirror_wraps_command_output_and_exit() {
        let m = git_mirror("git commit -m x", "1 file changed\n", "", 0);
        assert!(m.contains("[git] $ git commit -m x"));
        assert!(m.contains("1 file changed\r\n"));
        assert!(m.contains("[git] exit 0"));
    }

    #[test]
    fn shell_quote_wraps_plain() {
        assert_eq!(shell_quote("main"), "'main'");
    }

    #[test]
    fn shell_quote_escapes_single_quote() {
        // it's → '\''  →  'it'\''s'
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn ssh_command_quotes_cwd_and_args() {
        let cmd = ssh_command("/tmp/my repo", &["status".into(), "--porcelain".into()]);
        assert_eq!(
            cmd,
            "GIT_TERMINAL_PROMPT=0 git -C '/tmp/my repo' 'status' '--porcelain'"
        );
    }

    #[test]
    fn ssh_command_neutralizes_injection() {
        // A branch name trying to inject a second command stays a single arg.
        let cmd = ssh_command("/repo", &["checkout".into(), "x; rm -rf /".into()]);
        assert_eq!(
            cmd,
            "GIT_TERMINAL_PROMPT=0 git -C '/repo' 'checkout' 'x; rm -rf /'"
        );
    }
}
