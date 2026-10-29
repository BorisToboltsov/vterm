// Network access check, local transport (v1.0.36). The Utilities "access check"
// asks "can THIS host reach those ports?". On an SSH tab the question is answered
// by a script run on the server (built in `src/lib/netcheck/netcheck.ts`, executed by the
// `netcheck_run` bridge). On a local tab THIS host is the user's machine, so the
// connects are made here, natively — no second script dialect for macOS
// (no GNU `timeout`) and Windows (no `sh`), and exact refused/timeout verdicts
// straight from the socket error.
//
// This is the one narrow exception to the offline invariant (ADR 0004, see
// INVARIANTS "Сквозные принципы" §6): only on an explicit click, only to hosts
// and ports the user typed, only a TCP handshake that is closed at once with no
// payload. The route-source lookup uses a *connected UDP socket*, which sends
// nothing — it only asks the kernel which address it would use. The gate
// `app_originated_sockets_live_only_in_ssh_and_netcheck` keeps it that narrow.
//
// Output is the same tab-separated line protocol the remote script prints
// (documented in netcheck.ts), with verdicts already classified (`N` lines), so
// the frontend parses both transports with one function.
//
// The user may instead pick one of their own tools — bash /dev/tcp, nc, telnet,
// curl — the same ones a server offers (v1.22, ADR 0033): to see what that tool
// says from this machine. The argv of each is fixed here, the page only names
// the tool, so a page that went bad can't make `bash -c` run anything else.
// The wait is bounded here too (the child is killed at the timeout), which is
// what macOS lacks a `timeout` for. Those runs print the raw readings (`R`
// lines), like the remote script: the verdict is `classifyAttempt`'s.

use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use std::ffi::{OsStr, OsString};
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::{TcpSocket, TcpStream};

/// Parallel connects at a time (matches `BATCH` in netcheck.ts).
const BATCH: usize = 32;
/// Hard cap per run from this host (matches `MAX_CHECKS` in netcheck.ts): a /24
/// on eight ports fits, a typo like `1-65535` doesn't (ADR 0032).
pub const MAX_CHECKS: usize = 2048;

/// One host to probe and its ports (mirror of `NetTarget` in netcheck.ts).
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetTarget {
    pub host: String,
    pub ports: Vec<u16>,
}

/// Reject input the protocol can't carry (tabs/newlines would forge lines) or
/// that exceeds the per-run cap. A host is a name or an IPv4 address — the
/// alphabet the frontend's rules allow — and never starts with `-`: a local tool
/// gets it as an argument, and `-e…` would be read as an option. The frontend
/// validates too; this is the backend's own boundary.
pub fn validate(targets: &[NetTarget]) -> Result<(), String> {
    let mut total = 0usize;
    for t in targets {
        let h = t.host.trim();
        if h.is_empty()
            || h.len() > 253
            || h.starts_with('-')
            || !h
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            return Err(format!("netcheck: bad host {:?}", t.host));
        }
        if t.ports.contains(&0) {
            return Err("netcheck: port 0".into());
        }
        total += t.ports.len();
    }
    if total > MAX_CHECKS {
        return Err(format!("netcheck: more than {MAX_CHECKS} checks"));
    }
    Ok(())
}

/// Verdict for a failed connect, by socket error kind.
fn classify(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::ConnectionRefused => "refused",
        ErrorKind::TimedOut => "timeout",
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => "unreachable",
        _ => "error",
    }
}

/// Protocol fields can't contain the separator or a line break.
fn field(s: &str) -> String {
    s.replace(['\t', '\r', '\n'], " ")
}

/// Which local address the kernel would route `ip` from — a connected UDP
/// socket reports it without sending a single packet. `None` when there is no
/// route (the connect then fails with a proper verdict of its own).
fn route_src(ip: IpAddr) -> Option<IpAddr> {
    let bind: SocketAddr = match ip {
        IpAddr::V4(_) => (Ipv4Addr::UNSPECIFIED, 0).into(),
        IpAddr::V6(_) => (Ipv6Addr::UNSPECIFIED, 0).into(),
    };
    let sock = UdpSocket::bind(bind).ok()?;
    sock.connect(SocketAddr::new(ip, 9)).ok()?;
    let src = sock.local_addr().ok()?.ip();
    (!src.is_unspecified()).then_some(src)
}

/// This machine's name and addresses (`addr/prefix`), loopback included like
/// `ip -o addr` — the frontend decides what to show.
fn host_facts() -> (String, Vec<String>) {
    let hostname = sysinfo::System::host_name().unwrap_or_default();
    let nets = sysinfo::Networks::new_with_refreshed_list();
    let mut addrs = Vec::new();
    for data in nets.list().values() {
        for ipn in data.ip_networks() {
            let a = format!("{}/{}", ipn.addr, ipn.prefix);
            if !addrs.contains(&a) {
                addrs.push(a);
            }
        }
    }
    (hostname, addrs)
}

/// Resolve a target: a literal IP as-is, otherwise the first address (IPv4
/// preferred, like the remote `getent ahostsv4`). `Err` = did not resolve.
async fn resolve(host: &str) -> Result<IpAddr, ()> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, 0))
        .await
        .map_err(|_| ())?
        .collect();
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or(addrs.first())
        .map(|a| a.ip())
        .ok_or(())
}

/// Windows answers a refused SYN by *retrying* it for ~2 s before reporting
/// `ConnectionRefused`, so under a short timeout a port nobody listens on would
/// read as "timeout — a firewall drops it": the wrong diagnosis (principle 5).
/// `SIO_TCP_INITIAL_RTO` turns SYN retransmissions off for this socket only, and
/// stretches the one SYN's wait to the whole timeout, so a slow link still gets
/// its full budget. Best-effort: on a stack that rejects the ioctl the connect
/// just keeps Windows' default behaviour.
#[cfg(windows)]
fn no_syn_retries(sock: &TcpSocket, timeout: Duration) {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{
        WSAIoctl, SIO_TCP_INITIAL_RTO, SOCKET, TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS,
        TCP_INITIAL_RTO_PARAMETERS,
    };
    let params = TCP_INITIAL_RTO_PARAMETERS {
        // 0xFFFF means "unspecified"; stay below it.
        Rtt: timeout.as_millis().clamp(1, 65_000) as u16,
        // Declared `(UCHAR)-2` in mstcpip.h; windows-sys widens it to u16.
        MaxSynRetransmissions: TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS as u8,
    };
    let mut returned = 0u32;
    // SAFETY: `params` outlives the synchronous call, the in-buffer length is
    // its exact size, there is no out-buffer, and no overlapped I/O is used.
    unsafe {
        WSAIoctl(
            sock.as_raw_socket() as SOCKET,
            SIO_TCP_INITIAL_RTO,
            &params as *const TCP_INITIAL_RTO_PARAMETERS as *const core::ffi::c_void,
            std::mem::size_of::<TCP_INITIAL_RTO_PARAMETERS>() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
            None,
        );
    }
}

/// Open the socket ourselves (rather than `TcpStream::connect`) so the Windows
/// SYN-retry tweak can be applied before connecting.
async fn tcp_connect(addr: SocketAddr, timeout: Duration) -> std::io::Result<TcpStream> {
    let sock = if addr.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    #[cfg(windows)]
    no_syn_retries(&sock, timeout);
    #[cfg(not(windows))]
    let _ = timeout;
    sock.connect(addr).await
}

/// One handshake: `(status, elapsed ms, detail)`. The stream is dropped at once.
async fn connect_once(ip: IpAddr, port: u16, timeout: Duration) -> (&'static str, u128, String) {
    let start = Instant::now();
    let res = tokio::time::timeout(timeout, tcp_connect(SocketAddr::new(ip, port), timeout)).await;
    let ms = start.elapsed().as_millis();
    match res {
        Ok(Ok(stream)) => {
            drop(stream);
            ("open", ms, String::new())
        }
        Ok(Err(e)) => (classify(e.kind()), ms, e.to_string()),
        Err(_) => ("timeout", ms, String::new()),
    }
}

// ── The user's own tools (ADR 0033) ─────────────────────────────────────────

/// A probe tool of the user's that a local tab may run instead of the native
/// connect — the same four a server offers (`PROBE_TOOLS` in netcheck.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalTool {
    Bash,
    Nc,
    Telnet,
    Curl,
}

impl LocalTool {
    pub const ALL: [LocalTool; 4] = [Self::Bash, Self::Nc, Self::Telnet, Self::Curl];

    /// The tool the page named; anything else is not a tool.
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Nc => "nc",
            Self::Telnet => "telnet",
            Self::Curl => "curl",
        }
    }

    /// Whether this check can run it here. On Windows only curl can: `bash` in
    /// System32 is WSL — another machine on the network as far as a firewall
    /// rule is concerned — its telnet prints nothing on connect, so an open port
    /// would read as a timeout, and the nc builds there disagree on `-z`.
    fn supported(self) -> bool {
        cfg!(not(windows)) || self == Self::Curl
    }

    /// The fixed argv after the program, for one `host:port`. The host comes
    /// last or as a positional argument of `bash -c` (`$0`), never inside the
    /// command text, and `validate` keeps it from starting with `-`.
    fn argv(self, host: &str, port: u16, timeout_secs: u64, curl_scheme: &str) -> Vec<String> {
        let t = timeout_secs.to_string();
        let port = port.to_string();
        match self {
            Self::Bash => vec![
                "-c".into(),
                r#"exec 3<>"/dev/tcp/$0/$1""#.into(),
                host.into(),
                port,
            ],
            Self::Nc => vec!["-z".into(), "-v".into(), "-w".into(), t, host.into(), port],
            Self::Telnet => vec![host.into(), port],
            Self::Curl => vec![
                "-sS".into(),
                "-o".into(),
                (if cfg!(windows) { "NUL" } else { "/dev/null" }).into(),
                "-w".into(),
                "TC=%{time_connect} ".into(),
                "--connect-timeout".into(),
                t.clone(),
                "-m".into(),
                t,
                format!("{curl_scheme}://{host}:{port}"),
            ],
        }
    }
}

/// One tool as found on this machine: its state in the protocol (`ok`,
/// `missing`, `unsupported`) and the program to run when it is usable.
struct Found {
    tool: LocalTool,
    state: &'static str,
    program: OsString,
}

/// Look the four tools up on the user's PATH (`localenv`: a packaged macOS app
/// starts with a minimal one). The wait is bounded here, so no tool needs
/// `timeout`; what decides is whether the program is there.
async fn find_tools() -> (OsString, Vec<Found>) {
    let mut path = OsString::new();
    let mut found = Vec::new();
    for tool in LocalTool::ALL {
        let exe = if cfg!(windows) {
            format!("{}.exe", tool.name())
        } else {
            tool.name().to_string()
        };
        let (program, p) = crate::localenv::resolved_local(&exe).await;
        path = p;
        let there = std::path::Path::new(&program).is_absolute()
            && std::path::Path::new(&program).is_file();
        let state = if !tool.supported() {
            "unsupported"
        } else if there {
            "ok"
        } else {
            "missing"
        };
        found.push(Found {
            tool,
            state,
            program,
        });
    }
    (path, found)
}

/// A minimal curl (curl-minimal on RHEL 9) has no `telnet://`; `http://`
/// connects just the same, and the connect time is what's read either way —
/// the remote script makes the same choice.
async fn curl_scheme(program: &OsStr, path: &OsStr) -> &'static str {
    let mut cmd = tokio::process::Command::new(program);
    cmd.arg("-V")
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::localenv::no_console_window(&mut cmd);
    match tokio::time::timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(out))
            if String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .any(|w| w == "telnet") =>
        {
            "telnet"
        }
        _ => "http",
    }
}

/// Nanoseconds since the epoch — the remote script's `date +%s%N`.
fn epoch_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Run a tool once and report the raw reading: `(rc, start ns, end ns, its
/// output)`. A tool still waiting at the timeout is killed and reads 124, the
/// code GNU `timeout` gives; curl and nc bound themselves and get half a second
/// more to say so in their own words. Not found → 127, like a shell.
async fn tool_once(
    program: &OsStr,
    path: &OsStr,
    argv: Vec<String>,
    timeout: Duration,
) -> (i32, u128, u128, String) {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&argv)
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::localenv::no_console_window(&mut cmd);
    let start_ns = epoch_ns();
    let start = Instant::now();
    let res = tokio::time::timeout(timeout + Duration::from_millis(500), cmd.output()).await;
    let end_ns = start_ns + start.elapsed().as_nanos();
    match res {
        Ok(Ok(out)) => {
            let text = format!(
                "{} {}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            (out.status.code().unwrap_or(-1), start_ns, end_ns, text)
        }
        Ok(Err(e)) => (127, start_ns, end_ns, e.to_string()),
        Err(_) => (124, start_ns, end_ns, String::new()),
    }
}

/// A tool's output as one protocol field: no separators, no line breaks, at
/// most 240 characters (the script's `cut -c1-240`).
fn reading(text: &str) -> String {
    field(text.trim()).chars().take(240).collect()
}

// ── The runs ─────────────────────────────────────────────────────────────────

/// Who is checking — `H`, `A` — and what it could check with — `C` per tool —
/// for both kinds of run: the tool tiles read it from the identity probe.
fn header(found: &[Found]) -> String {
    let (hostname, addrs) = host_facts();
    let mut out = format!("H\t{}\n", field(&hostname));
    for a in &addrs {
        out.push_str(&format!("A\t{a}\n"));
    }
    for f in found {
        out.push_str(&format!("C\t{}\t{}\n", f.tool.name(), f.state));
    }
    out
}

/// Resolve each target once — `D` for a name, `S` for the address the route
/// leaves from — and lay out one job per port. A failed name still gets its
/// jobs (with no address).
async fn resolve_targets(
    targets: &[NetTarget],
    out: &mut String,
) -> Vec<(String, u16, Option<IpAddr>)> {
    let mut jobs = Vec::new();
    for t in targets {
        let host = t.host.trim();
        let ip = resolve(host).await.ok();
        if host.parse::<IpAddr>().is_err() {
            let shown = ip.map(|i| i.to_string()).unwrap_or_default();
            out.push_str(&format!("D\t{}\t{shown}\n", field(host)));
        }
        if let Some(src) = ip.and_then(route_src) {
            out.push_str(&format!("S\t{}\t{src}\n", field(host)));
        }
        for &p in &t.ports {
            jobs.push((host.to_string(), p, ip));
        }
    }
    jobs
}

/// Run every check with `tool` and print the line protocol: `H`/`A`/`C`/`M`,
/// `D`/`S`, an `R` per port with the tool's raw reading, `E`. `M none` when the
/// tool can't run here — then every port reads 127, as on a server that lacks
/// the picked tool. Stops like [`run_native`].
pub async fn run_tool(
    targets: &[NetTarget],
    timeout: Duration,
    cancel: &AtomicBool,
    tool: LocalTool,
) -> String {
    let (path, found) = find_tools().await;
    let mut out = header(&found);
    let usable = found
        .iter()
        .find(|f| f.tool == tool && f.state == "ok")
        .map(|f| f.program.clone());
    out.push_str(&format!(
        "M\t{}\n",
        if usable.is_some() {
            tool.name()
        } else {
            "none"
        }
    ));
    let scheme = match &usable {
        Some(program) if tool == LocalTool::Curl && !targets.is_empty() => {
            curl_scheme(program, &path).await
        }
        _ => "telnet",
    };
    let jobs = resolve_targets(targets, &mut out).await;
    let secs = timeout.as_secs().max(1);
    let (usable, path) = (&usable, &path);
    let mut lines = stream::iter(jobs)
        .take_while(|_| std::future::ready(!cancel.load(Ordering::Relaxed)))
        .map(|(host, port, _)| async move {
            let (rc, start, end, text) = match usable {
                Some(program) => {
                    tool_once(program, path, tool.argv(&host, port, secs, scheme), timeout).await
                }
                None => (127, 0, 0, String::new()),
            };
            format!(
                "R\t{}\t{port}\t{rc}\t{start}\t{end}\t{}\n",
                field(&host),
                reading(&text)
            )
        })
        .buffer_unordered(BATCH);
    while let Some(l) = lines.next().await {
        out.push_str(&l);
    }
    if !cancel.load(Ordering::Relaxed) {
        out.push_str("E\n");
    }
    out
}

/// Run every check natively and print the line protocol (`H`/`A`/`C`/`M`/`D`/
/// `S`/`N`/`E`). With no targets it is an identity probe for the panel header
/// and the tool tiles. Once `cancel` is set no further connect starts and the
/// run ends without `E`; the caller reports it as stopped (ADR 0032).
pub async fn run_native(targets: &[NetTarget], timeout: Duration, cancel: &AtomicBool) -> String {
    let (_, found) = find_tools().await;
    let mut out = header(&found);
    out.push_str("M\tnative\n");
    let jobs = resolve_targets(targets, &mut out).await;

    // Unordered: a subnet is mostly hosts that never answer, and one waiting
    // out its timeout must not hold back the lines behind it.
    let mut lines = stream::iter(jobs)
        .take_while(|_| std::future::ready(!cancel.load(Ordering::Relaxed)))
        .map(|(host, port, ip)| async move {
            match ip {
                None => format!("N\t{}\t{port}\tdns\t\t\n", field(&host)),
                Some(ip) => {
                    let (status, ms, detail) = connect_once(ip, port, timeout).await;
                    format!(
                        "N\t{}\t{port}\t{status}\t{ms}\t{}\n",
                        field(&host),
                        field(&detail)
                    )
                }
            }
        })
        .buffer_unordered(BATCH);
    while let Some(l) = lines.next().await {
        out.push_str(&l);
    }
    if !cancel.load(Ordering::Relaxed) {
        out.push_str("E\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn target(host: &str, ports: &[u16]) -> NetTarget {
        NetTarget {
            host: host.into(),
            ports: ports.to_vec(),
        }
    }

    #[test]
    fn validate_rejects_protocol_breaking_hosts_and_oversized_runs() {
        assert!(validate(&[target("10.0.0.1", &[22, 80])]).is_ok());
        assert!(validate(&[target("a\tb", &[22])]).is_err());
        assert!(validate(&[target("a\nE", &[22])]).is_err());
        assert!(validate(&[target("", &[22])]).is_err());
        assert!(validate(&[target("h", &[0])]).is_err());
        // A local tool gets the host as an argument: no option, no URL parts.
        assert!(validate(&[target("-e", &[22])]).is_err());
        assert!(validate(&[target("a@b", &[22])]).is_err());
        assert!(validate(&[target("a/b", &[22])]).is_err());
        assert!(validate(&[target("db-01.corp_x", &[22])]).is_ok());
        let many: Vec<u16> = (1..=(MAX_CHECKS as u16 + 1)).collect();
        assert!(validate(&[target("h", &many)]).is_err());
    }

    #[test]
    fn classify_maps_socket_errors_to_verdicts() {
        assert_eq!(classify(ErrorKind::ConnectionRefused), "refused");
        assert_eq!(classify(ErrorKind::TimedOut), "timeout");
        assert_eq!(classify(ErrorKind::HostUnreachable), "unreachable");
        assert_eq!(classify(ErrorKind::NetworkUnreachable), "unreachable");
        assert_eq!(classify(ErrorKind::PermissionDenied), "error");
    }

    #[test]
    fn route_src_for_loopback_is_loopback() {
        let src = route_src(IpAddr::V4(Ipv4Addr::LOCALHOST)).unwrap();
        assert!(src.is_loopback());
    }

    #[tokio::test]
    async fn native_run_reports_open_and_refused_on_loopback() {
        // An open port: a listener we hold. A refused port: one we bound and
        // released, so nothing listens there (loopback answers with RST).
        let open = TcpListener::bind("127.0.0.1:0").unwrap();
        let open_port = open.local_addr().unwrap().port();
        let closed_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let out = run_native(
            &[target("127.0.0.1", &[open_port, closed_port])],
            Duration::from_secs(2),
            &AtomicBool::new(false),
        )
        .await;
        assert!(out.starts_with("H\t"), "{out}");
        assert!(out.contains("M\tnative\n"));
        assert!(
            out.contains(&format!("N\t127.0.0.1\t{open_port}\topen\t")),
            "{out}"
        );
        assert!(
            out.contains(&format!("N\t127.0.0.1\t{closed_port}\trefused\t")),
            "{out}"
        );
        // A refusal is reported at once, not after Windows' ~2 s of SYN retries
        // (which, under a short timeout, would have read as "timeout").
        let refused_ms: u128 = out
            .lines()
            .find(|l| l.starts_with(&format!("N\t127.0.0.1\t{closed_port}\t")))
            .and_then(|l| l.split('\t').nth(4))
            .and_then(|ms| ms.parse().ok())
            .expect("refused row carries a time");
        assert!(refused_ms < 1000, "refusal took {refused_ms} ms:\n{out}");
        assert!(out.contains("S\t127.0.0.1\t127.0.0.1\n"), "{out}");
        // A literal IP is not "resolved" — no D line, same as the remote script.
        assert!(!out.contains("D\t"));
        assert!(out.ends_with("E\n"));
    }

    #[tokio::test]
    async fn native_run_marks_unresolvable_names_as_dns() {
        // `.invalid` is reserved (RFC 2606) and never resolves.
        let out = run_native(
            &[target("no-such-host.invalid", &[22, 80])],
            Duration::from_secs(2),
            &AtomicBool::new(false),
        )
        .await;
        assert!(out.contains("D\tno-such-host.invalid\t\n"), "{out}");
        assert!(out.contains("N\tno-such-host.invalid\t22\tdns\t"), "{out}");
        assert!(out.contains("N\tno-such-host.invalid\t80\tdns\t"), "{out}");
    }

    #[tokio::test]
    async fn identity_probe_without_targets_is_complete() {
        let out = run_native(&[], Duration::from_secs(1), &AtomicBool::new(false)).await;
        assert!(out.contains("M\tnative\n"));
        assert!(!out.contains("N\t"));
        assert!(out.ends_with("E\n"));
        // What each tool would do here: the tiles read it before the first run.
        for tool in LocalTool::ALL {
            let line = out
                .lines()
                .find(|l| l.starts_with(&format!("C\t{}\t", tool.name())))
                .unwrap_or_else(|| panic!("no C line for {}:\n{out}", tool.name()));
            let state = line.rsplit('\t').next().unwrap();
            if tool.supported() {
                assert!(matches!(state, "ok" | "missing"), "{line}");
            } else {
                assert_eq!(state, "unsupported", "{line}");
            }
        }
    }

    #[test]
    fn tool_argv_is_fixed_and_the_host_is_never_command_text() {
        let bash = LocalTool::Bash.argv("db.corp", 5432, 3, "telnet");
        assert_eq!(bash[0], "-c");
        assert!(!bash[1].contains("db.corp"), "{bash:?}");
        assert_eq!(&bash[2..], ["db.corp", "5432"]);
        assert_eq!(
            LocalTool::Nc.argv("h", 22, 3, "telnet"),
            ["-z", "-v", "-w", "3", "h", "22"]
        );
        assert_eq!(LocalTool::Telnet.argv("h", 22, 3, "telnet"), ["h", "22"]);
        let curl = LocalTool::Curl.argv("h", 22, 3, "http");
        assert_eq!(curl.last().unwrap(), "http://h:22");
        assert!(curl.contains(&"--connect-timeout".to_string()));
        assert_eq!(LocalTool::parse("nc"), Some(LocalTool::Nc));
        assert_eq!(LocalTool::parse("sh"), None);
        assert_eq!(LocalTool::parse("auto"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tool_still_waiting_at_the_timeout_is_killed_and_reads_124() {
        let (program, path) = crate::localenv::resolved_local("sleep").await;
        let started = Instant::now();
        let (rc, t0, t1, _) = tool_once(
            &program,
            &path,
            vec!["5".into()],
            Duration::from_millis(200),
        )
        .await;
        assert_eq!(rc, 124);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        // Epoch nanoseconds, like `date +%s%N`: the frontend reads the time from them.
        assert!(t0.to_string().len() >= 16 && t1 > t0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_bash_run_prints_raw_readings_on_loopback() {
        let open = TcpListener::bind("127.0.0.1:0").unwrap();
        let open_port = open.local_addr().unwrap().port();
        let closed_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let out = run_tool(
            &[target("127.0.0.1", &[open_port, closed_port])],
            Duration::from_secs(2),
            &AtomicBool::new(false),
            LocalTool::Bash,
        )
        .await;
        assert!(out.contains("C\tbash\tok\n"), "{out}");
        assert!(out.contains("M\tbash\n"), "{out}");
        let row = |port: u16| -> Vec<String> {
            out.lines()
                .find(|l| l.starts_with(&format!("R\t127.0.0.1\t{port}\t")))
                .unwrap_or_else(|| panic!("no R line for {port}:\n{out}"))
                .split('\t')
                .map(String::from)
                .collect()
        };
        assert_eq!(row(open_port)[3], "0", "{out}");
        let refused = row(closed_port);
        assert_ne!(refused[3], "0", "{out}");
        assert!(refused[6].to_lowercase().contains("refused"), "{out}");
        assert!(refused[4].len() >= 16, "{out}");
        assert!(out.ends_with("E\n"));
    }

    #[tokio::test]
    async fn a_tool_that_cant_run_here_is_method_none_and_every_port_127() {
        // On Windows bash is unsupported; elsewhere a stopped-before-start run
        // is checked instead, so this test means something on every OS.
        if cfg!(windows) {
            let out = run_tool(
                &[target("127.0.0.1", &[1])],
                Duration::from_secs(1),
                &AtomicBool::new(false),
                LocalTool::Bash,
            )
            .await;
            assert!(out.contains("C\tbash\tunsupported\n"), "{out}");
            assert!(out.contains("M\tnone\n"), "{out}");
            assert!(out.contains("R\t127.0.0.1\t1\t127\t"), "{out}");
        } else {
            let out = run_tool(
                &[target("127.0.0.1", &[1, 2, 3])],
                Duration::from_secs(1),
                &AtomicBool::new(true),
                LocalTool::Bash,
            )
            .await;
            assert!(!out.contains("R\t"), "{out}");
            assert!(!out.ends_with("E\n"), "{out}");
        }
    }

    #[tokio::test]
    async fn a_stopped_run_starts_no_connect_and_has_no_end_marker() {
        // Stopped before the first connect: identity lines only, no `N`, no `E` —
        // the frontend reads the run as stopped, not as "nothing answered".
        let out = run_native(
            &[target("127.0.0.1", &[1, 2, 3])],
            Duration::from_secs(1),
            &AtomicBool::new(true),
        )
        .await;
        assert!(out.starts_with("H\t"), "{out}");
        assert!(!out.contains("N\t"), "{out}");
        assert!(!out.ends_with("E\n"), "{out}");
    }

    #[tokio::test]
    async fn a_run_stopped_midway_keeps_what_it_checked() {
        // 10.255.255.1 is unroutable-ish: the connect waits out the timeout, so
        // the flag set meanwhile stops every connect not yet started.
        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let f2 = flag.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            f2.store(true, Ordering::Relaxed);
        });
        let ports: Vec<u16> = (1..=200).collect();
        let started = Instant::now();
        let out = run_native(
            &[target("10.255.255.1", &ports)],
            Duration::from_secs(1),
            &flag,
        )
        .await;
        let rows = out.lines().filter(|l| l.starts_with("N\t")).count();
        assert!(rows <= BATCH, "{rows} connects after the stop:\n{out}");
        assert!(!out.ends_with("E\n"));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
    }

    /// A local spawn, spelled in two halves so this file's own count of spawns
    /// (`every_local_cli_spawn_hides_the_console_window`) sees only real ones.
    const SPAWN: &str = concat!("tokio::process::", "Command::new(");

    /// Code before the tests, line comments dropped.
    fn code(src: &str) -> String {
        let src = src.replace("\r\n", "\n");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        src[..end]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The body of top-level `fn <name>(` (async or not) up to its closing `}`
    /// at column 0.
    fn body_of(code: &str, name: &str) -> String {
        let at = code
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("{name} not found"));
        let rest = &code[at..];
        rest[..rest.find("\n}\n").unwrap_or(rest.len())].to_string()
    }

    /// Whether, as written, a local tool runs only with the argv fixed here and
    /// the page can do no more than name it: two spawns in this module (`-V` and
    /// the check), the check's argv only from `LocalTool::argv`, the command
    /// takes the tool by `LocalTool::parse`, and the local branch hands the
    /// runner no `args` from the page.
    fn tools_take_only_their_name(netcheck: &str, lib: &str) -> bool {
        let nc = code(netcheck);
        let spawns = nc.matches(SPAWN).count();
        let scheme = body_of(&nc, "curl_scheme");
        let once = body_of(&nc, "tool_once");
        let calls: Vec<&str> = nc
            .match_indices("tool_once(")
            .map(|(i, _)| &nc[i..])
            .collect();
        let run_calls: Vec<&&str> = calls
            .iter()
            .filter(|c| !c.starts_with("tool_once(\n    program: &OsStr"))
            .collect();
        let lib = code(lib);
        let run = body_of(&lib, "netcheck_run");
        let exec = body_of(&lib, "netcheck_exec");
        let local = &exec[exec.find("local_pty(").unwrap_or(0)..];
        spawns == 2
            && scheme.contains("Command::new(program)")
            && scheme.contains(".arg(\"-V\")")
            && !scheme.contains(".args(")
            && once.contains(".args(&argv)")
            && run_calls.len() == 1
            && run_calls[0].starts_with("tool_once(program, path, tool.argv(")
            && run.contains("netcheck::LocalTool::parse(name)")
            && local.contains("netcheck::run_tool(targets, timeout, cancel, tool)")
            && !local.contains("args")
    }

    #[test]
    fn a_local_tool_runs_only_its_fixed_argv() {
        // Gate (v1.22, ADR 0033): `bash` is a shell, so a page that could hand it
        // an argv could run anything on this machine. The page names the tool;
        // what runs is decided here.
        let nc = include_str!("netcheck.rs");
        let bridge = crate::commands::bridge_source();
        let lib = bridge.as_str();
        assert!(tools_take_only_their_name(nc, lib));
        // Planted: the check's argv comes from somewhere else.
        let planted = nc.replacen(
            "tool_once(program, path, tool.argv(&host, port, secs, scheme), timeout)",
            "tool_once(program, path, page_argv.clone(), timeout)",
            1,
        );
        assert_ne!(planted, nc);
        assert!(!tools_take_only_their_name(&planted, lib));
        // Planted: a third spawn.
        let planted = nc.replacen(
            "fn epoch_ns() -> u128 {",
            &format!("fn epoch_ns() -> u128 {{\n    let _ = {SPAWN}\"sh\");"),
            1,
        );
        assert!(!tools_take_only_their_name(&planted, lib));
        // Planted: the local branch passes the page's argv along.
        let planted = lib.replacen(
            "netcheck::run_tool(targets, timeout, cancel, tool)",
            "netcheck::run_tool(targets, timeout, cancel, tool, args)",
            1,
        );
        assert_ne!(planted, lib);
        assert!(!tools_take_only_their_name(nc, &planted));
    }

    /// Gate (v1.0.36): the app opens sockets of its own only for SSH (incl. the
    /// user's proxy) and for the explicit local access check. Any other module
    /// dialing out would break the offline invariant (ADR 0004) silently — the
    /// network is only ever reached on the user's behalf. Scans code with line
    /// comments stripped, so docs may name the primitives.
    #[test]
    fn app_originated_sockets_live_only_in_ssh_and_netcheck() {
        const ALLOWED: &[&str] = &["ssh.rs", "netcheck.rs"];
        const PRIMITIVES: &[&str] = &[
            "TcpStream::connect",
            "TcpSocket::",
            "UdpSocket::",
            "lookup_host(",
            "to_socket_addrs(",
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                if ALLOWED.contains(&name.as_str()) {
                    continue;
                }
                let src = std::fs::read_to_string(&path).unwrap();
                for (i, line) in src.lines().enumerate() {
                    let code = line.split("//").next().unwrap_or("");
                    if PRIMITIVES.iter().any(|p| code.contains(p)) {
                        offenders.push(format!(
                            "{}:{}",
                            path.strip_prefix(&root).unwrap().display(),
                            i + 1
                        ));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "sockets opened outside ssh.rs/netcheck.rs (offline invariant): {offenders:?}"
        );
    }
}
