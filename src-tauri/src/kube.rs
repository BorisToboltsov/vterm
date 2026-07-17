// Kubernetes panel backend (Phase 37). A single thin executor runs one `kubectl`
// command and captures stdout/stderr/exit code — nothing more. All argument
// building and output parsing lives on the frontend (`src/lib/k8s.ts`), keeping
// this side dumb and testable-in-TS per the "pure logic in .ts" invariant. This
// is a distinct orchestration driver (its own view), not folded into the Docker
// panel — see INVARIANTS ("k8s — отдельный драйвер").
//
// Two transports, one contract (like the terminal, `git_run` and `container_run`):
// SSH tabs run the command on a dedicated exec channel (`SshSession::exec_captured`,
// remote `kubectl`), local shell tabs spawn `kubectl` here via `tokio::process`.
// The command surface is the same either way — an argument vector whose leading
// token(s) are the program (`kubectl`, or e.g. `k3s kubectl`), the rest its
// arguments.
//
// The `--context`/`--namespace`/`-A` scope is baked into every argv by the
// frontend (`k8s.ts withScope`); kubeconfig is NEVER mutated here (no
// `config use-context`). Offline invariant intact: the cluster's API server is
// reached over the user's own session (remote host or local machine); the
// app/WebView never opens a socket.

use crate::error::AppResult;
use serde::Serialize;
use std::time::Duration;

/// Captured result of one `kubectl` invocation (mirror of
/// [`crate::container::ContainerOutput`]).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Build the shell command run on the remote for an SSH tab: every argv token is
/// single-quoted (via [`crate::git::shell_quote`]) so a pod name / namespace /
/// label can't break out into a second command. The leading token(s) are the
/// program (`kubectl`, or `k3s kubectl` when the user configured a wrapper), the
/// rest its arguments — the remote login shell runs the string.
pub fn kube_command(args: &[String]) -> String {
    args.iter()
        .map(|a| crate::git::shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Run the command locally (`args[0]` is the program, e.g. `kubectl`), bounded by
/// `timeout_secs`. No shell is involved — args are passed verbatim, so no quoting
/// is needed. A timeout collapses into a non-zero exit + stderr note so the
/// frontend sees a uniform [`KubeOutput`].
pub async fn run_local(args: &[String], timeout_secs: u64) -> AppResult<KubeOutput> {
    let (prog, rest) = args
        .split_first()
        .ok_or_else(|| "kube: no arguments".to_string())?;
    // Reconstruct the user's PATH (a packaged macOS `.app` inherits only a minimal
    // one, so `kubectl` — in /usr/local/bin, /opt/homebrew/bin, etc. — isn't
    // found). See `localenv`. The command is still spawned without a shell (args
    // verbatim), exactly like the Docker/git panels.
    let (resolved, path) = crate::localenv::resolved_local(prog).await;
    let mut command = tokio::process::Command::new(&resolved);
    command
        .args(rest)
        .env("PATH", &path)
        .stdin(std::process::Stdio::null())
        // Terminate the child if we abandon it on timeout, so a stuck `kubectl`
        // (e.g. an unreachable API server) can't linger.
        .kill_on_drop(true);

    let fut = command.output();
    let output = match tokio::time::timeout(Duration::from_secs(timeout_secs.max(1)), fut).await {
        Ok(Ok(out)) => out,
        // Spawn failed (e.g. ENOENT: the binary isn't on the reconstructed PATH).
        // Surface it as a captured non-zero result so the frontend's
        // `parseAvailability` classifies it ("kubectl not installed") instead of a
        // hard Err shown as the generic "check failed".
        Ok(Err(e)) => {
            return Ok(KubeOutput {
                stdout: String::new(),
                stderr: format!("{prog}: {e}"),
                exit_code: 127,
            })
        }
        Err(_) => {
            return Ok(KubeOutput {
                stdout: String::new(),
                stderr: format!("{prog} timed out after {timeout_secs}s"),
                exit_code: -1,
            })
        }
    };

    Ok(KubeOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Render a mutating k8s-panel op for the session recording (audit): a magenta
/// `[k8s] $ <command>` header, the combined output, and a `[k8s] exit N` footer.
/// Mirrors [`crate::container::container_mirror`] — recorded ONLY, never emitted
/// to the live terminal.
pub fn kube_mirror(command: &str, stdout: &str, stderr: &str, exit_code: i32) -> String {
    let body = format!("{stdout}{stderr}").replace('\n', "\r\n");
    format!(
        "\r\n\u{1b}[35m[k8s] $ {command}\u{1b}[0m\r\n{body}\r\n\u{1b}[35m[k8s] exit {exit_code}\u{1b}[0m\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kube_mirror_wraps_command_output_and_exit() {
        let m = kube_mirror("kubectl delete pod abc", "pod \"abc\" deleted\n", "", 0);
        assert!(m.contains("[k8s] $ kubectl delete pod abc"));
        assert!(m.contains("pod \"abc\" deleted\r\n"));
        assert!(m.contains("[k8s] exit 0"));
    }

    #[test]
    fn kube_command_quotes_each_token() {
        let cmd = kube_command(&["kubectl".into(), "get".into(), "pods".into()]);
        assert_eq!(cmd, "'kubectl' 'get' 'pods'");
    }

    #[test]
    fn kube_command_quotes_wrapper_program() {
        // `k3s kubectl …` — the wrapper's tokens are quoted individually too.
        let cmd = kube_command(&["k3s".into(), "kubectl".into(), "get".into(), "nodes".into()]);
        assert_eq!(cmd, "'k3s' 'kubectl' 'get' 'nodes'");
    }

    #[test]
    fn kube_command_neutralizes_injection() {
        // A pod name trying to inject a second command stays a single arg.
        let cmd = kube_command(&[
            "kubectl".into(),
            "delete".into(),
            "pod".into(),
            "x; rm -rf /".into(),
        ]);
        assert_eq!(cmd, "'kubectl' 'delete' 'pod' 'x; rm -rf /'");
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
