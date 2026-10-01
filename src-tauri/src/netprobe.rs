// Network-diagnostics backend (Phase 34). A single thin executor runs one
// diagnostic command and captures stdout/stderr/exit code — nothing more. All
// argument building and output parsing lives on the frontend
// (`src/lib/{probe,tls,http}.ts`), keeping this side dumb and testable-in-TS per
// the "pure logic in .ts" invariant.
//
// Two transports by session (`probe_run` in lib.rs): an SSH tab runs the probe
// on the user's server, so the traffic originates there. A local tab spawns the
// user's own `curl`/`openssl` on this machine (ADR 0014) — the narrow, click-only
// counterpart of the access check (ADR 0012): only the programs allowed below,
// only to the address the user typed, never through a shell. The app itself
// still opens no socket for it (the socket gate in netcheck.rs holds).

use crate::git::shell_quote;
use serde::Serialize;

/// Captured result of one probe invocation (mirror of [`crate::git::GitOutput`]).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Build the shell command run on the remote: every argv token is single-quoted
/// (via [`shell_quote`]) so a hostname/URL/header can't break out into a second
/// command. Pipeline tools (openssl/curl chains) pass their whole pipeline as a
/// single `sh -c '<pipeline>'` token, which the remote shell then interprets.
pub fn probe_command(args: &[String]) -> String {
    args.iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The programs a local tab may spawn for the Utilities' network tools: the
/// user's own `curl` (HTTP client) and `openssl` (TLS inspector), by bare name
/// or a path ending in one (`.exe` on Windows). Anything else — `sh`, `cmd`,
/// `powershell` — would turn the probe into an arbitrary local command.
pub fn local_program_allowed(prog: &str) -> bool {
    let name = prog.rsplit(['/', '\\']).next().unwrap_or(prog);
    let name = name.strip_suffix(".exe").unwrap_or(name);
    matches!(name, "curl" | "openssl")
}

/// Render a network-utility run for the session recording (audit): a magenta
/// `[util] $ <command>` header, the combined output (LF → CRLF so it doesn't
/// staircase on replay), and a `[util] exit N` footer. Mirrors
/// [`crate::git::git_mirror`], recorded ONLY (never emitted to the live
/// terminal), so the GUI stays clean while the recording keeps a full audit
/// trail of what ran on the host.
pub fn probe_mirror(command: &str, stdout: &str, stderr: &str, exit_code: i32) -> String {
    let body = format!("{stdout}{stderr}").replace('\n', "\r\n");
    format!(
        "\r\n\u{1b}[35m[util] $ {command}\u{1b}[0m\r\n{body}\r\n\u{1b}[35m[util] exit {exit_code}\u{1b}[0m\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_mirror_wraps_command_output_and_exit() {
        let m = probe_mirror("'curl' 'https://x'", "200 OK\n", "", 0);
        assert!(m.contains("[util] $ 'curl' 'https://x'"));
        assert!(m.contains("200 OK\r\n"));
        assert!(m.contains("[util] exit 0"));
    }

    #[test]
    fn only_curl_and_openssl_run_locally() {
        for ok in [
            "curl",
            "openssl",
            "curl.exe",
            "C:\\Windows\\System32\\curl.exe",
            "/opt/homebrew/bin/openssl",
        ] {
            assert!(local_program_allowed(ok), "{ok}");
        }
        for bad in [
            "sh",
            "bash",
            "cmd",
            "powershell",
            "curlx",
            "evil/curl-wrapper",
            "",
            "rm",
        ] {
            assert!(!local_program_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn probe_command_quotes_each_token() {
        let cmd = probe_command(&["dig".into(), "+short".into(), "example.com".into()]);
        assert_eq!(cmd, "'dig' '+short' 'example.com'");
    }

    #[test]
    fn probe_command_neutralizes_injection() {
        // A host trying to inject a second command stays a single quoted arg.
        let cmd = probe_command(&["ping".into(), "-c".into(), "1".into(), "x; rm -rf /".into()]);
        assert_eq!(cmd, "'ping' '-c' '1' 'x; rm -rf /'");
    }

    #[test]
    fn probe_command_preserves_pipeline_token() {
        let pipeline = "echo | openssl s_client -connect 'h':443 | openssl x509 -noout -dates";
        let cmd = probe_command(&["sh".into(), "-c".into(), pipeline.into()]);
        assert_eq!(
            cmd,
            "'sh' '-c' 'echo | openssl s_client -connect '\\''h'\\'':443 | openssl x509 -noout -dates'"
        );
    }
}
