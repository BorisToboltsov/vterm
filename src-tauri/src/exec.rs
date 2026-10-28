// One execution contract for the panel drivers (ADR 0005): git, docker, kubectl
// and the network probes all run one argv over whichever transport the session
// has (INVARIANTS principle 3) and hand back the same captured result. Argument
// building and output parsing live on the frontend (`git.ts`, `docker.ts`,
// `k8s.ts`, `probe.ts`); this module only executes and captures — it used to be
// four near-copies, one per driver, that had drifted apart in small ways (a
// missing program was an exit 127 for docker and an error for git; a probe with
// stdin and one without answered a missing `curl` differently).
//
// Which argv a driver may run at all is the driver's own policy (`git::check_args`,
// `container::check_args`, `kube::check_args`, `netprobe::local_program_allowed`):
// the WebView is a trust boundary, and these are the checks behind it.

use crate::error::AppResult;
use crate::ssh::ExecOutcome;
use serde::Serialize;
use std::time::Duration;

/// Captured result of one driver command. A timeout and a program that cannot
/// be started fold into a non-zero exit + a stderr note, so the frontend reads
/// one shape whatever happened.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// The command line an SSH tab runs: every argv token single-quoted (via
/// [`crate::git::shell_quote`]) so a container id, pod name, path or host can't
/// break out into a second command. The remote login shell runs the string.
pub fn remote_command(args: &[String]) -> String {
    args.iter()
        .map(|a| crate::git::shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// An SSH exec result as an [`ExecOutput`]: a timeout becomes exit −1 with
/// `"<label> timed out after Ns"` in place of stderr.
pub fn from_remote(outcome: ExecOutcome, label: &str, timeout_secs: u64) -> ExecOutput {
    let (stderr, exit_code) = if outcome.timed_out {
        (format!("{label} timed out after {timeout_secs}s"), -1)
    } else {
        (outcome.stderr, outcome.exit_code)
    };
    ExecOutput {
        stdout: outcome.stdout,
        stderr,
        exit_code,
    }
}

/// Render a mutating driver op for the session recording (audit): a magenta
/// `[<tag>] $ <command>` header, the combined output (LF → CRLF so it doesn't
/// staircase on replay), and a `[<tag>] exit N` footer. Recorded ONLY — never
/// emitted to the live terminal, so the GUI stays clean while the recording keeps
/// a complete trail. Never called for a command that carries a secret.
pub fn mirror(tag: &str, command: &str, out: &ExecOutput) -> String {
    let body = format!("{}{}", out.stdout, out.stderr).replace('\n', "\r\n");
    format!(
        "\r\n\u{1b}[35m[{tag}] $ {command}\u{1b}[0m\r\n{body}\r\n\u{1b}[35m[{tag}] exit {}\u{1b}[0m\r\n",
        out.exit_code
    )
}

/// What a local run answers when its program cannot be started at all.
#[derive(Clone, Copy)]
pub enum Missing {
    /// Exit 127 + stderr, like a shell: panels that tell "not installed" from the
    /// result (`parseAvailability` in docker.ts / k8s.ts) and the probes.
    Exit127,
    /// An error, shown by the panel as a failure (git, registry login).
    Error,
}

/// One local spawn: the program, its arguments verbatim (no shell is involved,
/// so nothing is quoted), extra environment, and what to feed on stdin.
pub struct Local<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub env: &'a [(&'a str, &'a str)],
    pub stdin: Option<&'a [u8]>,
    pub missing: Missing,
    /// Appended to the timeout note — why a run of this program may hang.
    pub timeout_hint: &'a str,
}

/// Run a program locally, bounded by `timeout_secs`. The program is resolved on
/// the user's reconstructed PATH (`localenv`: a packaged macOS `.app` inherits
/// only a minimal one), spawned without a shell and without a console window on
/// Windows (the panels poll every few seconds), and killed if abandoned on
/// timeout — a stuck `git` would otherwise hold `.git/index.lock` for the next
/// command. stdin, when given, is written and closed (`--password-stdin`, a probe
/// step fed the previous one's output); otherwise the child gets none.
pub async fn run_local(cmd: Local<'_>, timeout_secs: u64) -> AppResult<ExecOutput> {
    use tokio::io::AsyncWriteExt;
    let timeout_secs = timeout_secs.max(1);
    let program = cmd.program;
    let (resolved, path) = crate::localenv::resolved_local(program).await;
    let mut command = tokio::process::Command::new(&resolved);
    command
        .args(cmd.args)
        .envs(cmd.env.iter().copied())
        .env("PATH", &path)
        .stdin(if cmd.stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::localenv::no_console_window(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return match cmd.missing {
                // ENOENT and the like: a captured result the frontend classifies,
                // not a hard error shown as the generic "check failed".
                Missing::Exit127 => Ok(ExecOutput {
                    stdout: String::new(),
                    stderr: format!("{program}: {e}"),
                    exit_code: 127,
                }),
                Missing::Error => Err(format!("{program} failed to run: {e}").into()),
            };
        }
    };
    if let (Some(input), Some(mut sink)) = (cmd.stdin, child.stdin.take()) {
        let _ = sink.write_all(input).await;
        let _ = sink.shutdown().await; // EOF, so `--password-stdin` proceeds
    }
    let fut = child.wait_with_output();
    let output = match tokio::time::timeout(Duration::from_secs(timeout_secs), fut).await {
        Ok(res) => res.map_err(|e| format!("{program} failed to run: {e}"))?,
        Err(_) => {
            return Ok(ExecOutput {
                stdout: String::new(),
                stderr: format!(
                    "{program} timed out after {timeout_secs}s{}",
                    cmd.timeout_hint
                ),
                exit_code: -1,
            })
        }
    };
    Ok(ExecOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local<'a>(program: &'a str, args: &'a [String], missing: Missing) -> Local<'a> {
        Local {
            program,
            args,
            env: &[],
            stdin: None,
            missing,
            timeout_hint: "",
        }
    }

    #[test]
    fn remote_command_quotes_each_token() {
        let cmd = remote_command(&["docker".into(), "ps".into(), "-a".into()]);
        assert_eq!(cmd, "'docker' 'ps' '-a'");
        // `k3s kubectl …` — a wrapper's tokens are quoted individually too.
        let cmd = remote_command(&["k3s".into(), "kubectl".into(), "get".into()]);
        assert_eq!(cmd, "'k3s' 'kubectl' 'get'");
    }

    #[test]
    fn remote_command_neutralizes_injection() {
        // A container id trying to inject a second command stays a single arg.
        let cmd = remote_command(&["docker".into(), "rm".into(), "x; rm -rf /".into()]);
        assert_eq!(cmd, "'docker' 'rm' 'x; rm -rf /'");
    }

    #[test]
    fn remote_command_preserves_a_pipeline_token() {
        let pipeline = "echo | openssl s_client -connect 'h':443 | openssl x509 -noout -dates";
        let cmd = remote_command(&["sh".into(), "-c".into(), pipeline.into()]);
        assert_eq!(
            cmd,
            "'sh' '-c' 'echo | openssl s_client -connect '\\''h'\\'':443 | openssl x509 -noout -dates'"
        );
    }

    #[test]
    fn a_remote_timeout_becomes_exit_minus_one_with_a_note() {
        let outcome = ExecOutcome {
            stdout: "partial".into(),
            stderr: "ignored".into(),
            exit_code: 0,
            timed_out: true,
        };
        let out = from_remote(outcome, "kubectl", 20);
        assert_eq!(out.exit_code, -1);
        assert_eq!(out.stderr, "kubectl timed out after 20s");
        assert_eq!(out.stdout, "partial");
    }

    #[test]
    fn mirror_wraps_command_output_and_exit() {
        let out = ExecOutput {
            stdout: "1 file changed\n".into(),
            stderr: String::new(),
            exit_code: 0,
        };
        let m = mirror("git", "git commit -m x", &out);
        assert!(m.contains("[git] $ git commit -m x"));
        assert!(m.contains("1 file changed\r\n"));
        assert!(m.contains("[git] exit 0"));
    }

    #[tokio::test]
    async fn a_missing_program_is_exit_127_or_an_error_as_asked() {
        let args: Vec<String> = Vec::new();
        let out = run_local(
            local("definitely-not-a-real-binary-xyz", &args, Missing::Exit127),
            5,
        )
        .await
        .unwrap();
        assert_eq!(out.exit_code, 127);
        assert!(out.stderr.contains("definitely-not-a-real-binary-xyz"));
        let err = run_local(
            local("definitely-not-a-real-binary-xyz", &args, Missing::Error),
            5,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("failed to run"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_reaches_the_child_and_is_closed() {
        let args: Vec<String> = Vec::new();
        let mut cmd = local("cat", &args, Missing::Error);
        cmd.stdin = Some(b"hello");
        let out = run_local(cmd, 5).await.unwrap();
        assert_eq!((out.stdout.as_str(), out.exit_code), ("hello", 0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_local_timeout_names_the_program_and_the_hint() {
        let args = vec!["5".to_string()];
        let mut cmd = local("sleep", &args, Missing::Error);
        cmd.timeout_hint = " — still asleep";
        let out = run_local(cmd, 1).await.unwrap();
        assert_eq!(out.exit_code, -1);
        assert_eq!(out.stderr, "sleep timed out after 1s — still asleep");
    }
}
