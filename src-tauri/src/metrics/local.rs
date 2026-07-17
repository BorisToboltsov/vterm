//! Native local-machine metrics for **local shell tabs** (Phase 38).
//!
//! SSH sessions feed the status bar / monitoring overlay from the `/proc` shell
//! probes in [`super`] (`run_command`). A local tab has no SSH session, and `/proc`
//! doesn't exist on macOS/Windows, so those probes can't run locally. Instead we
//! read the *same* [`Metrics`]/[`MetricsDetail`]/[`Extras`] fields through
//! [`sysinfo`], which is cross-OS (macOS/Windows/Linux) and offline (pure syscalls,
//! no network). Dispatch (SSH vs local) happens in [`super`] by session presence —
//! the same transport-by-session pattern as `git_run`/`container_run`/`kubectl_run`.
//!
//! As a **descendant module** of [`super`], this file constructs the metric DTOs
//! directly even though their fields are private to `super`.
//!
//! CPU% and per-second net/disk rates need two samples, so each collector takes two
//! snapshots ~200 ms apart (stateless — no per-session sample store to clear on
//! disconnect, unlike the delta-tracking SSH path). Server-shaped fields with no
//! honest cross-OS source (PSI, conntrack, systemd units, `who`, inodes, package
//! updates, GPU/SMART) are left `None`/empty; the UI already renders those as “—”.

use std::time::{Duration, Instant};

use sysinfo::{
    Components, Disks, Networks, ProcessStatus, ProcessesToUpdate, System, Users,
    MINIMUM_CPU_UPDATE_INTERVAL,
};

use super::{Extras, Hardware, Metrics, MetricsDetail, NetIface, Partition, Proc, Sensor};

/// Gap between the two samples. `sysinfo` needs at least [`MINIMUM_CPU_UPDATE_INTERVAL`]
/// between CPU refreshes for a meaningful percentage; 200 ms is a comfortable floor.
fn sample_interval() -> Duration {
    MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(200))
}

/// The current OS user (`$USER` on Unix, `%USERNAME%` on Windows); empty if unset.
fn current_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

// ── Pure helpers (unit-tested; no live system needed) ───────────────────────────

/// A loopback interface across OSes: Linux `lo`, macOS `lo0`, Windows "Loopback…".
fn is_loopback(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "lo" || n == "lo0" || n.contains("loopback")
}

/// The Windows system drive, e.g. `C:\`. (No-op filter on Unix, where mounts are paths.)
fn is_system_drive(mount: &str) -> bool {
    mount.trim().to_ascii_uppercase().starts_with("C:")
}

/// Pick the root/system disk as `(used, total)` bytes from `(mount, total, avail)`
/// entries: prefer `/` (Unix) or `C:` (Windows), else the largest real disk. Entries
/// with zero total (pseudo-mounts) are ignored; `None` when there are no real disks.
fn root_disk(entries: &[(String, u64, u64)]) -> Option<(u64, u64)> {
    let real = || entries.iter().filter(|(_, total, _)| *total > 0);
    let chosen = real()
        .find(|(m, _, _)| m == "/" || is_system_drive(m))
        .or_else(|| real().max_by_key(|(_, total, _)| *total))?;
    let (_, total, avail) = chosen;
    Some((total.saturating_sub(*avail), *total))
}

/// Sum received/transmitted bytes across non-loopback interfaces (`(name, rx, tx)`).
fn sum_net(ifaces: &[(String, u64, u64)]) -> (u64, u64) {
    ifaces
        .iter()
        .filter(|(name, _, _)| !is_loopback(name))
        .fold((0, 0), |(r, t), (_, rx, tx)| (r + rx, t + tx))
}

/// "name NN%, …" for the top `n` CPU consumers (`(name, cpu%)`), skipping idle ones.
fn top_procs_label(procs: &[(String, f64)], n: usize) -> String {
    let mut ranked: Vec<&(String, f64)> = procs.iter().filter(|(_, cpu)| *cpu > 0.0).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    ranked
        .iter()
        .take(n)
        .map(|(name, cpu)| format!("{name} {}%", cpu.round() as i64))
        .collect::<Vec<_>>()
        .join(", ")
}

// ── sysinfo glue ────────────────────────────────────────────────────────────────

/// Cumulative received/transmitted bytes over the sampling window (non-loopback).
fn net_totals(nets: &Networks) -> (u64, u64) {
    let entries: Vec<(String, u64, u64)> = nets
        .list()
        .iter()
        .map(|(name, d)| (name.clone(), d.received(), d.transmitted()))
        .collect();
    sum_net(&entries)
}

/// Total disk read/written bytes over the window, summed across live processes
/// (`sysinfo` has no global per-device counter cross-OS; the process deltas do).
fn disk_io_totals(sys: &System) -> (u64, u64) {
    sys.processes().values().fold((0, 0), |(r, w), p| {
        let du = p.disk_usage();
        (r + du.read_bytes, w + du.written_bytes)
    })
}

/// Best-effort CPU temperature: a CPU/package/core-labelled component if present,
/// else the hottest component; `None` when no sensors are exposed (common on Windows).
fn cpu_temp(components: &Components) -> Option<f64> {
    let mut cpuish: Option<f64> = None;
    let mut hottest: Option<f64> = None;
    for c in components.list() {
        let Some(temp) = c.temperature().map(f64::from) else {
            continue;
        };
        let label = c.label().to_ascii_lowercase();
        if ["cpu", "package", "core", "tdie", "tctl"]
            .iter()
            .any(|k| label.contains(k))
        {
            cpuish = Some(cpuish.map_or(temp, |m: f64| m.max(temp)));
        }
        hottest = Some(hottest.map_or(temp, |m: f64| m.max(temp)));
    }
    cpuish.or(hottest)
}

/// First non-loopback IPv4 address, if any (best-effort; empty otherwise).
fn local_ipv4(nets: &Networks) -> Option<String> {
    for (name, d) in nets.list() {
        if is_loopback(name) {
            continue;
        }
        for ipn in d.ip_networks() {
            if let std::net::IpAddr::V4(v4) = ipn.addr {
                if !v4.is_loopback() && !v4.is_unspecified() {
                    return Some(v4.to_string());
                }
            }
        }
    }
    None
}

/// One [`Proc`] row per live process (unsorted); callers rank by CPU or memory.
fn proc_rows(sys: &System, users: &Users, total_mem: u64) -> Vec<Proc> {
    sys.processes()
        .values()
        .map(|p| {
            let user = p
                .user_id()
                .and_then(|uid| users.get_user_by_id(uid))
                .map(|u| u.name().to_string())
                .unwrap_or_default();
            let mem = if total_mem > 0 {
                p.memory() as f64 / total_mem as f64 * 100.0
            } else {
                0.0
            };
            Proc {
                pid: p.pid().as_u32(),
                user,
                cpu: p.cpu_usage() as f64,
                mem,
                comm: p.name().to_string_lossy().into_owned(),
            }
        })
        .collect()
}

/// Real mounted filesystems as [`Partition`]s (inode counts unavailable via sysinfo).
fn partitions(disks: &Disks) -> Vec<Partition> {
    disks
        .list()
        .iter()
        .filter(|d| d.total_space() > 0)
        .map(|d| {
            let total = d.total_space();
            let avail = d.available_space();
            Partition {
                mount: d.mount_point().to_string_lossy().into_owned(),
                fstype: d.file_system().to_string_lossy().into_owned(),
                used: total.saturating_sub(avail),
                total,
                inodes_used: None,
                inodes_total: None,
            }
        })
        .collect()
}

/// Temperature sensors from `sysinfo` components (drops entries with no reading).
fn sensors(components: &Components) -> Vec<Sensor> {
    components
        .list()
        .iter()
        .filter_map(|c| {
            let temp = f64::from(c.temperature()?);
            Some(Sensor {
                label: c.label().to_string(),
                temp,
                high: c.max().map(f64::from),
                crit: c.critical().map(f64::from),
            })
        })
        .collect()
}

/// Per-interface network rows with per-second rates over `secs` (non-loopback).
/// `sysinfo` exposes error counters but not drops, so drops report 0.
fn net_ifaces(nets: &Networks, secs: f64) -> Vec<NetIface> {
    nets.list()
        .iter()
        .filter(|(name, _)| !is_loopback(name))
        .map(|(name, d)| NetIface {
            name: name.clone(),
            rx_rate: (d.received() as f64 / secs) as u64,
            tx_rate: (d.transmitted() as f64 / secs) as u64,
            rx_errs: d.errors_on_received(),
            rx_drop: 0,
            tx_errs: d.errors_on_transmitted(),
            tx_drop: 0,
        })
        .collect()
}

// ── Collectors (mirror the four `fetch_*` commands' SSH paths) ──────────────────

/// Load average as a `(1, 5, 15)` triple — Unix only; Windows has no such concept
/// (`sysinfo` reports zeros there), so it stays `None` and renders as “—”.
fn load_average() -> (Option<f64>, Option<f64>, Option<f64>) {
    #[cfg(not(windows))]
    {
        let la = System::load_average();
        (Some(la.one), Some(la.five), Some(la.fifteen))
    }
    #[cfg(windows)]
    {
        (None, None, None)
    }
}

/// Status-bar metrics for the local machine (two samples ~200 ms apart).
pub(super) async fn collect_metrics() -> Metrics {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut nets = Networks::new_with_refreshed_list();

    let t0 = Instant::now();
    tokio::time::sleep(sample_interval()).await;

    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    nets.refresh(false);
    let secs = t0.elapsed().as_secs_f64().max(1e-3);

    let total_mem = sys.total_memory();
    let (net_rx, net_tx) = net_totals(&nets);
    let (disk_r, disk_w) = disk_io_totals(&sys);
    let procs: Vec<(String, f64)> = sys
        .processes()
        .values()
        .map(|p| {
            (
                p.name().to_string_lossy().into_owned(),
                p.cpu_usage() as f64,
            )
        })
        .collect();
    let (disk_used, disk_total) = match root_disk_from_disks(&Disks::new_with_refreshed_list()) {
        Some((used, total)) => (Some(used), Some(total)),
        None => (None, None),
    };
    let (load1, load5, load15) = load_average();
    let os = System::name().unwrap_or_default();
    let pretty_name = {
        let p = System::long_os_version().unwrap_or_default();
        if p.is_empty() {
            os.clone()
        } else {
            p
        }
    };

    Metrics {
        os,
        pretty_name,
        hostname: System::host_name().unwrap_or_default(),
        user: current_user(),
        kernel: System::kernel_version().unwrap_or_default(),
        cpu_pct: Some(f64::from(sys.global_cpu_usage())),
        mem_total: Some(total_mem),
        mem_used: Some(total_mem.saturating_sub(sys.available_memory())),
        swap_total: Some(sys.total_swap()),
        swap_used: Some(sys.used_swap()),
        uptime_secs: Some(System::uptime()),
        disk_used,
        disk_total,
        load1,
        load5,
        load15,
        net_rx_rate: Some((net_rx as f64 / secs) as u64),
        net_tx_rate: Some((net_tx as f64 / secs) as u64),
        disk_read_rate: Some((disk_r as f64 / secs) as u64),
        disk_write_rate: Some((disk_w as f64 / secs) as u64),
        top_proc: top_procs_label(&procs, 3),
        cpu_temp: cpu_temp(&Components::new_with_refreshed_list()),
        ip: local_ipv4(&nets).unwrap_or_default(),
        ..Default::default()
    }
}

/// Extract `(mount, total, avail)` tuples and pick the root disk. Split from
/// [`root_disk`] so the selection logic stays pure and testable.
fn root_disk_from_disks(disks: &Disks) -> Option<(u64, u64)> {
    let entries: Vec<(String, u64, u64)> = disks
        .list()
        .iter()
        .map(|d| {
            (
                d.mount_point().to_string_lossy().into_owned(),
                d.total_space(),
                d.available_space(),
            )
        })
        .collect();
    root_disk(&entries)
}

/// Detailed monitoring-overlay metrics (heavier; two samples ~200 ms apart).
pub(super) async fn collect_detail() -> MetricsDetail {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut nets = Networks::new_with_refreshed_list();

    let t0 = Instant::now();
    tokio::time::sleep(sample_interval()).await;

    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    nets.refresh(false);
    let secs = t0.elapsed().as_secs_f64().max(1e-3);

    let users = Users::new_with_refreshed_list();
    let total_mem = sys.total_memory();
    let mut rows = proc_rows(&sys, &users, total_mem);

    let per_cpu = sys
        .cpus()
        .iter()
        .map(|c| f64::from(c.cpu_usage()))
        .collect();

    rows.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    let top_procs: Vec<Proc> = rows.iter().take(6).cloned().collect();
    rows.sort_by(|a, b| b.mem.total_cmp(&a.mem));
    let top_mem_procs: Vec<Proc> = rows.iter().take(6).cloned().collect();
    let top_mem = rows
        .iter()
        .take(3)
        .map(|p| format!("{} {}%", p.comm, p.mem.round() as i64))
        .collect::<Vec<_>>()
        .join(", ");

    let components = Components::new_with_refreshed_list();
    let sensors_installed = !components.list().is_empty();
    let procs_running = sys
        .processes()
        .values()
        .filter(|p| p.status() == ProcessStatus::Run)
        .count() as u64;

    MetricsDetail {
        per_cpu,
        mem_total: Some(total_mem),
        mem_free: Some(sys.free_memory()),
        mem_available: Some(sys.available_memory()),
        // mem_buffers / mem_cached are Linux `/proc/meminfo` concepts → left None.
        top_procs,
        top_mem,
        top_mem_procs,
        partitions: partitions(&Disks::new_with_refreshed_list()),
        sensors: sensors(&components),
        sensors_installed,
        net_ifaces: net_ifaces(&nets, secs),
        procs_running: Some(procs_running),
        ..Default::default()
    }
}

/// Static machine spec for the overlay's hardware card. GPU/Docker/SMART/OOM are
/// server-shaped and skipped locally; the CPU spec fills cleanly from sysinfo.
pub(super) async fn collect_extras() -> Extras {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    let cpus = sys.cpus();
    let threads = cpus.len() as u32;
    let (model, mhz) = cpus
        .first()
        .map(|c| (c.brand().trim().to_string(), c.frequency()))
        .unwrap_or_default();

    let hardware = Hardware {
        cpu_model: model,
        cpu_threads: (threads > 0).then_some(threads),
        cpu_mhz: (mhz > 0).then_some(mhz as f64),
        arch: System::cpu_arch(),
        ..Default::default()
    };
    Extras {
        hardware,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_detection_across_oses() {
        assert!(is_loopback("lo"));
        assert!(is_loopback("lo0"));
        assert!(is_loopback("Loopback Pseudo-Interface 1"));
        assert!(!is_loopback("eth0"));
        assert!(!is_loopback("en0"));
    }

    #[test]
    fn system_drive_is_windows_c() {
        assert!(is_system_drive("C:\\"));
        assert!(is_system_drive("c:\\"));
        assert!(!is_system_drive("D:\\"));
        assert!(!is_system_drive("/"));
    }

    #[test]
    fn root_disk_prefers_slash_then_largest() {
        // `/` wins even when a bigger disk exists.
        let e = vec![("/data".into(), 900, 100), ("/".into(), 500, 200)];
        assert_eq!(root_disk(&e), Some((300, 500)));

        // No `/` → largest real disk; zero-total pseudo-mounts ignored.
        let e = vec![
            ("/snap".into(), 0, 0),
            ("/mnt/a".into(), 400, 150),
            ("/mnt/b".into(), 800, 300),
        ];
        assert_eq!(root_disk(&e), Some((500, 800)));

        // Windows system drive.
        let e = vec![("D:\\".into(), 200, 50), ("C:\\".into(), 600, 100)];
        assert_eq!(root_disk(&e), Some((500, 600)));

        assert_eq!(root_disk(&[]), None);
    }

    #[test]
    fn sum_net_excludes_loopback() {
        let ifaces = vec![
            ("lo".into(), 1000, 1000),
            ("eth0".into(), 30, 70),
            ("en0".into(), 5, 15),
        ];
        assert_eq!(sum_net(&ifaces), (35, 85));
    }

    #[test]
    fn top_procs_label_ranks_and_rounds() {
        let procs = vec![
            ("idle".into(), 0.0),
            ("node".into(), 87.4),
            ("bash".into(), 3.6),
            ("postgres".into(), 12.5),
        ];
        assert_eq!(top_procs_label(&procs, 2), "node 87%, postgres 13%");
        assert_eq!(top_procs_label(&[], 3), "");
    }

    #[tokio::test]
    async fn collect_metrics_reports_memory_and_os() {
        let m = collect_metrics().await;
        assert!(m.mem_total.unwrap_or(0) > 0, "total memory should be known");
        assert!(m.mem_used.unwrap_or(0) <= m.mem_total.unwrap());
        assert!(!m.pretty_name.is_empty(), "OS name should be populated");
        let cpu = m.cpu_pct.unwrap_or(-1.0);
        assert!((0.0..=100.0).contains(&cpu), "cpu% in range, got {cpu}");
    }

    #[tokio::test]
    async fn collect_detail_reports_cores_and_memory() {
        let d = collect_detail().await;
        assert!(!d.per_cpu.is_empty(), "per-core usage should be populated");
        assert!(d.per_cpu.iter().all(|c| (0.0..=100.0).contains(c)));
        assert!(d.mem_total.unwrap_or(0) > 0, "total memory should be known");
    }

    #[tokio::test]
    async fn collect_extras_fills_hardware() {
        let e = collect_extras().await;
        assert!(!e.hardware.arch.is_empty(), "arch should be populated");
    }
}
