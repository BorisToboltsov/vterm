// Docker panel backend (Phase 35). A single thin executor runs one `docker`
// command and captures stdout/stderr/exit code — nothing more. All argument
// building and output parsing lives on the frontend (`src/lib/docker.ts`),
// keeping this side dumb and testable-in-TS per the "pure logic in .ts" invariant.
//
// Two transports, one contract (like the terminal and `git_run`): SSH tabs run
// the command on a dedicated exec channel (`SshSession::exec_captured`, remote
// `docker`), local shell tabs spawn `docker` here via `tokio::process`. The
// command surface is the same either way — an argument vector whose first token
// is the program (`docker`). Unlike `probe_run` (SSH-only), the Docker panel
// works on local tabs too, so both transports exist here.
//
// Offline invariant intact: the Docker daemon is reached over the user's own
// session (remote host or local machine); the app/WebView never opens a socket.

use crate::error::AppResult;
use serde::Serialize;
use std::time::Duration;

/// Captured result of one `docker` invocation (mirror of [`crate::git::GitOutput`]).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Build the shell command run on the remote for an SSH tab: every argv token is
/// single-quoted (via [`crate::git::shell_quote`]) so a container id / image name
/// / label can't break out into a second command. The first token is the program
/// (`docker`), the rest its arguments — the remote login shell runs the string.
pub fn container_command(args: &[String]) -> String {
    args.iter()
        .map(|a| crate::git::shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Run the command locally (`args[0]` is the program, e.g. `docker`), bounded by
/// `timeout_secs`. No shell is involved — args are passed verbatim, so no quoting
/// is needed. A timeout collapses into a non-zero exit + stderr note so the
/// frontend sees a uniform [`ContainerOutput`].
pub async fn run_local(args: &[String], timeout_secs: u64) -> AppResult<ContainerOutput> {
    let (prog, rest) = args
        .split_first()
        .ok_or_else(|| "container: no arguments".to_string())?;
    // Reconstruct the user's PATH (a packaged macOS `.app` inherits only a minimal
    // one, so `docker` — in /usr/local/bin or /opt/homebrew/bin — isn't found). See
    // `localenv`. The command is still spawned without a shell (args verbatim).
    let (resolved, path) = crate::localenv::resolved_local(prog).await;
    let mut command = tokio::process::Command::new(&resolved);
    command
        .args(rest)
        .env("PATH", &path)
        .stdin(std::process::Stdio::null())
        // Terminate the child if we abandon it on timeout, so a stuck `docker`
        // (e.g. a daemon that stops responding) can't linger.
        .kill_on_drop(true);
    // No flashing console window on Windows (the panel polls every few seconds).
    crate::localenv::no_console_window(&mut command);

    let fut = command.output();
    let output = match tokio::time::timeout(Duration::from_secs(timeout_secs.max(1)), fut).await {
        Ok(Ok(out)) => out,
        // Spawn failed (e.g. ENOENT: the binary isn't on the reconstructed PATH).
        // Surface it as a captured non-zero result so the frontend's
        // `parseAvailability` classifies it ("Docker not installed") instead of a
        // hard Err shown as the generic "check failed".
        Ok(Err(e)) => {
            return Ok(ContainerOutput {
                stdout: String::new(),
                stderr: format!("{prog}: {e}"),
                exit_code: 127,
            })
        }
        Err(_) => {
            return Ok(ContainerOutput {
                stdout: String::new(),
                stderr: format!("{prog} timed out after {timeout_secs}s"),
                exit_code: -1,
            })
        }
    };

    Ok(ContainerOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Run the command locally feeding `stdin` to the child (Phase 36): used for
/// `docker login --password-stdin` on a local tab so the registry password never
/// lands on the command line. Mirrors [`run_local`] but pipes stdin and closes it.
pub async fn run_local_stdin(
    args: &[String],
    stdin: &[u8],
    timeout_secs: u64,
) -> AppResult<ContainerOutput> {
    use tokio::io::AsyncWriteExt;
    let (prog, rest) = args
        .split_first()
        .ok_or_else(|| "container: no arguments".to_string())?;
    // Same PATH reconstruction as `run_local` so `docker login` finds the CLI in a
    // packaged macOS `.app` (see `localenv`); still no shell wraps the command.
    let (resolved, path) = crate::localenv::resolved_local(prog).await;
    let mut command = tokio::process::Command::new(&resolved);
    command
        .args(rest)
        .env("PATH", &path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // No flashing console window on Windows (docker login runs in the background).
    crate::localenv::no_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("{prog} failed to run: {e}"))?;

    if let Some(mut sink) = child.stdin.take() {
        let _ = sink.write_all(stdin).await;
        let _ = sink.shutdown().await; // EOF so `--password-stdin` proceeds
    }

    let fut = child.wait_with_output();
    let output = match tokio::time::timeout(Duration::from_secs(timeout_secs.max(1)), fut).await {
        Ok(res) => res.map_err(|e| format!("{prog} failed to run: {e}"))?,
        Err(_) => {
            return Ok(ContainerOutput {
                stdout: String::new(),
                stderr: format!("{prog} timed out after {timeout_secs}s"),
                exit_code: -1,
            })
        }
    };
    Ok(ContainerOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Render a mutating docker-panel op for the session recording (audit): a magenta
/// `[docker] $ <command>` header, the combined output, and a `[docker] exit N`
/// footer. Mirrors [`crate::git::git_mirror`] — recorded ONLY, never emitted to
/// the live terminal. Registry login is never passed here (it carries a secret).
pub fn container_mirror(command: &str, stdout: &str, stderr: &str, exit_code: i32) -> String {
    let body = format!("{stdout}{stderr}").replace('\n', "\r\n");
    format!(
        "\r\n\u{1b}[35m[docker] $ {command}\u{1b}[0m\r\n{body}\r\n\u{1b}[35m[docker] exit {exit_code}\u{1b}[0m\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_mirror_wraps_command_output_and_exit() {
        let m = container_mirror("docker rm abc", "abc\n", "", 0);
        assert!(m.contains("[docker] $ docker rm abc"));
        assert!(m.contains("abc\r\n"));
        assert!(m.contains("[docker] exit 0"));
    }

    #[test]
    fn container_command_quotes_each_token() {
        let cmd = container_command(&["docker".into(), "ps".into(), "-a".into()]);
        assert_eq!(cmd, "'docker' 'ps' '-a'");
    }

    #[test]
    fn container_command_neutralizes_injection() {
        // A container id trying to inject a second command stays a single arg.
        let cmd = container_command(&["docker".into(), "rm".into(), "x; rm -rf /".into()]);
        assert_eq!(cmd, "'docker' 'rm' 'x; rm -rf /'");
    }

    #[tokio::test]
    async fn run_local_reports_missing_program() {
        // A program that does not exist surfaces as a captured exit 127 (so the
        // frontend classifies "not installed"), not an Err or a panic.
        let res = run_local(&["definitely-not-a-real-binary-xyz".into()], 5)
            .await
            .unwrap();
        assert_eq!(res.exit_code, 127);
        assert!(res.stderr.contains("definitely-not-a-real-binary-xyz"));
    }
}
