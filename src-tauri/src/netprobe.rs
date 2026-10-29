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
//
// Execution and the result shape are the drivers' common ones (`exec`). On SSH a
// pipeline tool (openssl/curl chains) passes its whole pipeline as a single
// `sh -c '<pipeline>'` token, which the remote shell then interprets.

/// The programs a local tab may spawn for the Utilities' network tools: the
/// user's own `curl` (HTTP client) and `openssl` (TLS inspector), by bare name
/// or a path ending in one (`.exe` on Windows). Anything else — `sh`, `cmd`,
/// `powershell` — would turn the probe into an arbitrary local command.
pub fn local_program_allowed(prog: &str) -> bool {
    let name = prog.rsplit(['/', '\\']).next().unwrap_or(prog);
    let name = name.strip_suffix(".exe").unwrap_or(name);
    matches!(name, "curl" | "openssl")
}

/// Drop what a terminal would interpret: C0 controls (ESC above all), DEL and
/// C1. The text comes from a remote host (a certificate subject, a status line,
/// an error message) and is replayed by a terminal emulator — an embedded escape
/// sequence would repaint or retitle the player. Tabs survive; newlines only when
/// `multiline`.
fn printable(text: &str, multiline: bool) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\n' if multiline => Some('\n'),
            '\n' | '\r' | '\t' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

/// Render a network-utility run for the session recording (audit), in the same
/// shape as [`crate::sftp::sftp_mirror`]: a magenta `[util] $ <op>` header, the
/// body (LF → CRLF so it doesn't staircase on replay), a `[util] exit N` footer.
/// Recorded ONLY, never emitted to the live terminal. `op` and `body` are built
/// by the frontend from the PARSED result (`tlsAudit`/`httpAudit`/
/// `netcheckAudit`) with secrets already masked — never the raw argv or the raw
/// response, which carried header values, request bodies and `Set-Cookie`.
pub fn audit_block(op: &str, body: &str, exit_code: i32) -> String {
    let op = printable(op, false);
    let body = printable(body.trim_end(), true);
    let body = if body.is_empty() {
        String::new()
    } else {
        format!("{}\r\n", body.replace('\n', "\r\n"))
    };
    format!(
        "\r\n\u{1b}[35m[util] $ {op}\u{1b}[0m\r\n{body}\u{1b}[35m[util] exit {exit_code}\u{1b}[0m\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_block_matches_the_sftp_mirror_shape() {
        let m = audit_block(
            "tls example.com:443",
            "subject=CN=example.com\nnotAfter=x\n",
            0,
        );
        assert_eq!(
            m,
            "\r\n\u{1b}[35m[util] $ tls example.com:443\u{1b}[0m\r\nsubject=CN=example.com\r\nnotAfter=x\r\n\u{1b}[35m[util] exit 0\u{1b}[0m\r\n"
        );
        // No body → header and footer only, like a successful sftp op.
        assert!(!audit_block("netcheck", "", 1).contains("\r\n\r\n\u{1b}[35m[util] exit"));
    }

    #[test]
    fn audit_block_strips_what_a_terminal_would_interpret() {
        // A hostile server's status line / cert subject must not repaint the player.
        let m = audit_block(
            "http GET\nx",
            "HTTP/1.1 200 \u{1b}]0;pwned\u{7}OK\u{9b}2J\r",
            0,
        );
        assert!(m.contains("[util] $ http GET x"));
        assert!(m.contains("HTTP/1.1 200 ]0;pwnedOK2J"));
        let inner = m
            .trim_start_matches("\r\n\u{1b}[35m")
            .trim_end_matches("\u{1b}[0m\r\n");
        // The only ESCs left are the block's own colour codes.
        assert_eq!(inner.matches('\u{1b}').count(), 2, "{m:?}");
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
}
