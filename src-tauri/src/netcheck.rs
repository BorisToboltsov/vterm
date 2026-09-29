// Network access check, local transport (v1.0.36). The Utilities "access check"
// asks "can THIS host reach those ports?". On an SSH tab the question is answered
// by a script run on the server (built in `src/lib/netcheck.ts`, executed by the
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

use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;

/// Parallel connects at a time (matches `BATCH` in netcheck.ts).
const BATCH: usize = 32;
/// Hard cap per run (matches `MAX_CHECKS` in netcheck.ts).
pub const MAX_CHECKS: usize = 512;

/// One host to probe and its ports (mirror of `NetTarget` in netcheck.ts).
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetTarget {
    pub host: String,
    pub ports: Vec<u16>,
}

/// Reject input the protocol can't carry (tabs/newlines would forge lines) or
/// that exceeds the per-run cap. The frontend validates too; this is the
/// backend's own boundary.
pub fn validate(targets: &[NetTarget]) -> Result<(), String> {
    let mut total = 0usize;
    for t in targets {
        let h = t.host.trim();
        if h.is_empty() || h.len() > 253 || h.chars().any(|c| c.is_whitespace() || c.is_control()) {
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

/// One handshake: `(status, elapsed ms, detail)`. The stream is dropped at once.
async fn connect_once(ip: IpAddr, port: u16, timeout: Duration) -> (&'static str, u128, String) {
    let start = Instant::now();
    let res = tokio::time::timeout(timeout, TcpStream::connect(SocketAddr::new(ip, port))).await;
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

/// Run every check natively and print the line protocol (`H`/`A`/`M`/`D`/`S`/
/// `N`/`E`). With no targets it is an identity probe for the panel header.
pub async fn run_native(targets: &[NetTarget], timeout: Duration) -> String {
    let (hostname, addrs) = host_facts();
    let mut out = format!("H\t{}\n", field(&hostname));
    for a in &addrs {
        out.push_str(&format!("A\t{a}\n"));
    }
    out.push_str("M\tnative\n");

    // Resolve each target once; a failed name still gets a row per port.
    let mut jobs: Vec<(String, u16, Option<IpAddr>)> = Vec::new();
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

    let lines: Vec<String> = stream::iter(jobs)
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
        .buffered(BATCH)
        .collect()
        .await;
    for l in lines {
        out.push_str(&l);
    }
    out.push_str("E\n");
    out
}

/// Short audit label for the session recording: `netcheck host:22,80 …` — the
/// SSH script itself is long and says less than this.
pub fn audit_label(targets: &[NetTarget]) -> String {
    let parts: Vec<String> = targets
        .iter()
        .map(|t| {
            let ports: Vec<String> = t.ports.iter().map(|p| p.to_string()).collect();
            format!("{}:{}", t.host, ports.join(","))
        })
        .collect();
    format!("netcheck {}", parts.join(" "))
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
    fn audit_label_lists_targets_and_ports() {
        let l = audit_label(&[target("10.0.0.1", &[22, 80]), target("db", &[5432])]);
        assert_eq!(l, "netcheck 10.0.0.1:22,80 db:5432");
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
        )
        .await;
        assert!(out.contains("D\tno-such-host.invalid\t\n"), "{out}");
        assert!(out.contains("N\tno-such-host.invalid\t22\tdns\t"), "{out}");
        assert!(out.contains("N\tno-such-host.invalid\t80\tdns\t"), "{out}");
    }

    #[tokio::test]
    async fn identity_probe_without_targets_is_complete() {
        let out = run_native(&[], Duration::from_secs(1)).await;
        assert!(out.contains("M\tnative\n"));
        assert!(!out.contains("N\t"));
        assert!(out.ends_with("E\n"));
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
