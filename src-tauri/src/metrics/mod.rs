//! Remote metrics probes: the lightweight status-bar poll (`METRICS_SCRIPT`), the
//! heavier monitoring-overlay detail (`DETAIL_SCRIPT`), pending OS updates
//! (`PENDING_SCRIPT`), and lazy extras — GPU/Docker/SMART/OOM (`EXTRAS_SCRIPT`).
//!
//! Each probe is one portable shell snippet emitting `key=value` lines; pure
//! parsers turn that into typed structs. Delta metrics (CPU%, throughput,
//! per-core, ctx/intr) compare each probe against per-session samples kept in
//! [`MetricsSamples`], cleared on disconnect. Extracted from `lib.rs` in Phase 18.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

/// Native local-system metrics for local shell tabs (Phase 38). SSH sessions get
/// metrics from the `/proc` shell probes above; local tabs have no SSH session and
/// `/proc` doesn't exist on macOS/Windows, so this submodule reads the same
/// [`Metrics`]/[`MetricsDetail`]/[`Extras`] fields via `sysinfo`. As a descendant
/// module it constructs those (otherwise private) DTOs directly.
mod local;

/// Whether `session_id` names a live **local-shell PTY** rather than an SSH
/// session — the switch that routes a metrics probe to the native `sysinfo`
/// collector instead of `run_command`. Mirrors the transport-by-session dispatch
/// used by `git_run`/`container_run`/`kubectl_run`.
fn is_local_session(state: &State<'_, AppState>, session_id: &str) -> bool {
    state.local_ptys.lock().unwrap().contains_key(session_id)
}

/// Per-session, per-device cumulative `(a, b)` counters + sample instant, used for
/// per-interface network and per-device disk throughput deltas.
type DevSampleStore = Mutex<HashMap<String, HashMap<String, (u64, u64, Instant)>>>;

/// Per-session sample stores for the metrics probes, grouped so `AppState` holds
/// one field instead of eight. Each delta metric compares the current probe
/// against the previous sample kept here.
#[derive(Default)]
pub struct MetricsSamples {
    /// Last `/proc/stat` (idle, total) jiffies per session, for CPU% deltas.
    cpu_samples: Mutex<HashMap<String, (u64, u64)>>,
    /// Last cumulative network (rx, tx) bytes + instant per session, for rate deltas.
    net_samples: Mutex<HashMap<String, (u64, u64, Instant)>>,
    /// Last cumulative disk (read, written) bytes + instant per session, for rates.
    disk_samples: Mutex<HashMap<String, (u64, u64, Instant)>>,
    /// Last per-core `/proc/stat` (idle, total) jiffies per session, for per-core CPU%.
    core_samples: Mutex<HashMap<String, Vec<(u64, u64)>>>,
    /// Last aggregate `/proc/stat` cpu jiffies per session, for the CPU breakdown.
    cpu_stat_samples: Mutex<HashMap<String, [u64; 8]>>,
    /// Per-interface network and per-device disk throughput sample stores.
    iface_samples: DevSampleStore,
    diskdev_samples: DevSampleStore,
    /// Last cumulative (ctxt, intr) counters + instant per session, for rate deltas.
    ctxintr_samples: Mutex<HashMap<String, (u64, u64, Instant)>>,
}

impl MetricsSamples {
    /// Drop **all** of a session's samples when it disconnects. The old inline
    /// cleanup missed `net_samples`/`disk_samples`, leaking one entry per closed
    /// session; grouping the stores here lets us clear every one in a single place.
    pub fn clear_session(&self, id: &str) {
        self.cpu_samples.lock().unwrap().remove(id);
        self.net_samples.lock().unwrap().remove(id);
        self.disk_samples.lock().unwrap().remove(id);
        self.core_samples.lock().unwrap().remove(id);
        self.cpu_stat_samples.lock().unwrap().remove(id);
        self.iface_samples.lock().unwrap().remove(id);
        self.diskdev_samples.lock().unwrap().remove(id);
        self.ctxintr_samples.lock().unwrap().remove(id);
    }
}

// ── Remote metrics (bottom status bar) ─────────────────────────────────────────

/// One lightweight, portable shell snippet that prints `key=value` lines. Every
/// field is guarded so a missing tool/file just yields an empty value (which the
/// UI renders as a dash) rather than failing the whole probe.
const METRICS_SCRIPT: &str = "\
printf 'os=%s\\n' \"$(uname -s 2>/dev/null)\"; \
printf 'host=%s\\n' \"$(hostname 2>/dev/null)\"; \
printf 'user=%s\\n' \"$(id -un 2>/dev/null || whoami 2>/dev/null)\"; \
printf 'pretty=%s\\n' \"$( ( . /etc/os-release 2>/dev/null && printf %s \"$PRETTY_NAME\" ) || ( sw_vers -productName 2>/dev/null | tr -d '\\n' ) )\"; \
printf 'load=%s\\n' \"$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)\"; \
printf 'mem=%s\\n' \"$(awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{if(t>0)printf \"%d %d\",(t-a)*1024,t*1024}' /proc/meminfo 2>/dev/null)\"; \
printf 'disk=%s\\n' \"$(df -kP / 2>/dev/null | awk 'NR==2{printf \"%d %d\",$3*1024,$2*1024}')\"; \
printf 'cpustat=%s\\n' \"$(grep '^cpu ' /proc/stat 2>/dev/null | head -1 | sed 's/^cpu *//')\"; \
printf 'net=%s\\n' \"$(awk 'NR>2{sub(/:/,\"\",$1); if($1!=\"lo\"){rx+=$2; tx+=$10}} END{printf \"%d %d\",rx,tx}' /proc/net/dev 2>/dev/null)\"; \
printf 'uptime=%s\\n' \"$(cut -d. -f1 /proc/uptime 2>/dev/null)\"; \
printf 'swap=%s\\n' \"$(awk '/SwapTotal/{t=$2}/SwapFree/{f=$2}END{if(t>0)printf \"%d %d\",(t-f)*1024,t*1024}' /proc/meminfo 2>/dev/null)\"; \
printf 'diskio=%s\\n' \"$(awk '$3 ~ /^(sd|nvme|vd|xvd|hd)[a-z0-9]*$/ {r+=$6; w+=$10} END{printf \"%d %d\",r*512,w*512}' /proc/diskstats 2>/dev/null)\"; \
printf 'users=%s\\n' \"$(who 2>/dev/null | awk '{print $1}' | sort -u | tr '\\n' ' ')\"; \
printf 'ip=%s\\n' \"$(hostname -I 2>/dev/null | awk '{print $1}')\"; \
printf 'topproc=%s\\n' \"$(ps -eo pcpu=,comm= 2>/dev/null | sort -rn | head -3 | awk '{printf \"%s %d%%, \",$2,$1}' | sed 's/, $//')\"; \
printf 'cputemp=%s\\n' \"$(awk '{printf \"%.0f\",$1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)\"; \
printf 'netconns=%s\\n' \"$(ss -tH state established 2>/dev/null | wc -l | tr -d ' ')\"; \
printf 'kernel=%s\\n' \"$(uname -r 2>/dev/null)\"; \
printf 'stime=%s\\n' \"$(date '+%H:%M %Z' 2>/dev/null)\"";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    os: String,
    pretty_name: String,
    hostname: String,
    user: String,
    load1: Option<f64>,
    load5: Option<f64>,
    load15: Option<f64>,
    /// CPU utilization 0–100, computed from a `/proc/stat` delta between polls.
    cpu_pct: Option<f64>,
    mem_used: Option<u64>,
    mem_total: Option<u64>,
    disk_used: Option<u64>,
    disk_total: Option<u64>,
    /// Network throughput in bytes/sec, from a `/proc/net/dev` delta between polls.
    net_rx_rate: Option<u64>,
    net_tx_rate: Option<u64>,
    /// Disk I/O in bytes/sec, from a `/proc/diskstats` delta between polls.
    disk_read_rate: Option<u64>,
    disk_write_rate: Option<u64>,
    uptime_secs: Option<u64>,
    swap_used: Option<u64>,
    swap_total: Option<u64>,
    /// Space-separated logged-in usernames (count derived on the frontend).
    users: String,
    ip: String,
    /// Top CPU process as "name NN%".
    top_proc: String,
    cpu_temp: Option<f64>,
    net_conns: Option<u64>,
    kernel: String,
    /// Remote clock + timezone, e.g. "14:05 UTC".
    server_time: String,
}

fn parse_metrics(raw: &str) -> Metrics {
    let mut m = Metrics::default();
    for line in raw.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key {
            "os" => m.os = value.to_string(),
            "pretty" => m.pretty_name = value.to_string(),
            "host" => m.hostname = value.to_string(),
            "user" => m.user = value.to_string(),
            "load" => {
                let mut it = value.split_whitespace();
                m.load1 = it.next().and_then(|v| v.parse().ok());
                m.load5 = it.next().and_then(|v| v.parse().ok());
                m.load15 = it.next().and_then(|v| v.parse().ok());
            }
            "mem" => {
                let mut it = value.split_whitespace();
                m.mem_used = it.next().and_then(|v| v.parse().ok());
                m.mem_total = it.next().and_then(|v| v.parse().ok());
            }
            "disk" => {
                let mut it = value.split_whitespace();
                m.disk_used = it.next().and_then(|v| v.parse().ok());
                m.disk_total = it.next().and_then(|v| v.parse().ok());
            }
            "uptime" => m.uptime_secs = value.parse().ok(),
            "swap" => {
                let mut it = value.split_whitespace();
                m.swap_used = it.next().and_then(|v| v.parse().ok());
                m.swap_total = it.next().and_then(|v| v.parse().ok());
            }
            "users" => m.users = value.to_string(),
            "ip" => m.ip = value.to_string(),
            "topproc" => m.top_proc = value.to_string(),
            "cputemp" => m.cpu_temp = value.parse().ok(),
            "netconns" => m.net_conns = value.parse().ok(),
            "kernel" => m.kernel = value.to_string(),
            "stime" => m.server_time = value.to_string(),
            _ => {}
        }
    }
    if m.pretty_name.is_empty() {
        m.pretty_name = m.os.clone();
    }
    m
}

/// From a `/proc/stat` "cpu" line ("user nice system idle iowait …"), return
/// (idle_jiffies, total_jiffies). Idle counts both idle and iowait.
fn parse_cpustat(raw: &str) -> Option<(u64, u64)> {
    let line = raw.lines().find_map(|l| l.strip_prefix("cpustat="))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    if nums.len() < 5 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3] + nums[4];
    Some((idle, total))
}

/// Parse a `key=<a> <b>` line into a pair of cumulative `u64` counters. Used for
/// network (`net=rx tx`) and disk I/O (`diskio=read written`) byte deltas.
fn parse_pair(raw: &str, key: &str) -> Option<(u64, u64)> {
    let prefix = format!("{key}=");
    let line = raw.lines().find_map(|l| l.strip_prefix(prefix.as_str()))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    if nums.len() < 2 {
        return None;
    }
    Some((nums[0], nums[1]))
}

fn parse_net(raw: &str) -> Option<(u64, u64)> {
    parse_pair(raw, "net")
}

/// Turn cumulative counters into a per-second rate using the previous sample for
/// this session (updating it). Returns `(None, None)` on the first poll.
fn rate_from(
    samples: &Mutex<HashMap<String, (u64, u64, Instant)>>,
    session_id: &str,
    cur: (u64, u64),
) -> (Option<u64>, Option<u64>) {
    let now = Instant::now();
    let mut s = samples.lock().unwrap();
    let mut a = None;
    let mut b = None;
    if let Some(&(pa, pb, pinst)) = s.get(session_id) {
        let secs = now.duration_since(pinst).as_secs_f64();
        if secs > 0.0 {
            a = Some((cur.0.saturating_sub(pa) as f64 / secs) as u64);
            b = Some((cur.1.saturating_sub(pb) as f64 / secs) as u64);
        }
    }
    s.insert(session_id.to_string(), (cur.0, cur.1, now));
    (a, b)
}

/// Probe the active session for OS info and resource usage (status bar).
#[tauri::command]
pub async fn fetch_metrics(state: State<'_, AppState>, session_id: String) -> AppResult<Metrics> {
    let session = match state.sessions.lock().await.get(&session_id).cloned() {
        Some(s) => s,
        None if is_local_session(&state, &session_id) => return Ok(local::collect_metrics().await),
        None => return Err(AppError::NoSession),
    };
    let raw = session.run_command(METRICS_SCRIPT).await?;
    let mut m = parse_metrics(&raw);

    // CPU% needs two samples; the first poll for a session has no prior reading.
    if let Some((idle, total)) = parse_cpustat(&raw) {
        let mut samples = state.metrics_samples.cpu_samples.lock().unwrap();
        if let Some(&(pidle, ptotal)) = samples.get(&session_id) {
            let dt = total.saturating_sub(ptotal);
            let di = idle.saturating_sub(pidle);
            if dt > 0 {
                m.cpu_pct = Some(((dt - di) as f64 / dt as f64 * 100.0).clamp(0.0, 100.0));
            }
        }
        samples.insert(session_id.clone(), (idle, total));
    }

    // Network + disk I/O rates need two samples and the wall-clock gap between them.
    if let Some(net) = parse_net(&raw) {
        (m.net_rx_rate, m.net_tx_rate) =
            rate_from(&state.metrics_samples.net_samples, &session_id, net);
    }
    if let Some(dio) = parse_pair(&raw, "diskio") {
        (m.disk_read_rate, m.disk_write_rate) =
            rate_from(&state.metrics_samples.disk_samples, &session_id, dio);
    }
    Ok(m)
}

// ── Detailed metrics (monitoring overlay; fetched only while the page is open) ──

/// Richer, heavier probe than the status bar's `METRICS_SCRIPT`. Run only when
/// the monitoring overlay is open. Lines are `key=value`; multi-record values
/// (partitions, TCP states) pack records separated by `;`/spaces.
const DETAIL_SCRIPT: &str = "\
printf 'percpu=%s\\n' \"$(awk '/^cpu[0-9]/{idle=$5+$6; tot=0; for(i=2;i<=NF;i++)tot+=$i; printf \"%d,%d \",idle,tot}' /proc/stat 2>/dev/null)\"; \
printf 'memdetail=%s\\n' \"$(awk '/^MemTotal:/{t=$2}/^MemFree:/{f=$2}/^MemAvailable:/{a=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}END{printf \"%d %d %d %d %d\",t*1024,f*1024,a*1024,b*1024,c*1024}' /proc/meminfo 2>/dev/null)\"; \
printf 'topmem=%s\\n' \"$(ps -eo pmem=,comm= 2>/dev/null | sort -rn | head -3 | awk '{printf \"%s %s%%, \",$2,$1}' | sed 's/, $//')\"; \
printf 'parts=%s\\n' \"$(df -P -T -k 2>/dev/null | awk 'NR>1 && $2!~/^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup|cgroup2|mqueue|debugfs|tracefs|none)$/ {printf \"%s,%s,%d,%d;\",$7,$2,$3*1024,$4*1024}')\"; \
printf 'inodes=%s\\n' \"$(df -P -T -i 2>/dev/null | awk 'NR>1 && $2!~/^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup|cgroup2|mqueue|debugfs|tracefs|none)$/ {printf \"%s,%d,%d;\",$7,$3,$4}')\"; \
printf 'filenr=%s\\n' \"$(awk '{print $1, $3}' /proc/sys/fs/file-nr 2>/dev/null)\"; \
printf 'ulimit=%s\\n' \"$( (ulimit -Sn; ulimit -Hn) 2>/dev/null | tr '\\n' ' ')\"; \
printf 'psicpu=%s\\n' \"$(grep '^some' /proc/pressure/cpu 2>/dev/null)\"; \
printf 'psimem=%s\\n' \"$(grep '^some' /proc/pressure/memory 2>/dev/null)\"; \
printf 'psiio=%s\\n' \"$(grep '^some' /proc/pressure/io 2>/dev/null)\"; \
printf 'tcp=%s\\n' \"$(ss -tanH 2>/dev/null | awk '{print $1}' | sort | uniq -c | awk '{printf \"%s:%s \",$2,$1}')\"; \
printf 'sensors=%s\\n' \"$(sensors -u 2>/dev/null | awk '/^[^ ].*:$/{if(l!=\"\"&&v!=\"\"){printf \"%s,%s,%s,%s;\",l,v,h,c}l=$0;sub(/:$/,\"\",l);gsub(/,/,\"\",l);v=\"\";h=\"\";c=\"\";next}/temp[0-9]+_input:/{v=$2+0}/temp[0-9]+_max:/{h=$2+0}/temp[0-9]+_crit:/{c=$2+0}END{if(l!=\"\"&&v!=\"\"){printf \"%s,%s,%s,%s;\",l,v,h,c}}')\"; \
printf 'sensorsbin=%s\\n' \"$(command -v sensors >/dev/null 2>&1 && echo 1)\"; \
printf 'cpubreak=%s\\n' \"$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null)\"; \
printf 'topcpu=%s\\n' \"$(ps -eo pid=,user=,pcpu=,pmem=,comm= 2>/dev/null | sort -k3 -rn | head -6 | awk '{printf \"%s|%s|%s|%s|%s;\",$1,$2,$3,$4,$5}')\"; \
printf 'topmemp=%s\\n' \"$(ps -eo pid=,user=,pcpu=,pmem=,comm= 2>/dev/null | sort -k4 -rn | head -6 | awk '{printf \"%s|%s|%s|%s|%s;\",$1,$2,$3,$4,$5}')\"; \
printf 'failed=%s\\n' \"$(command -v systemctl >/dev/null 2>&1 && systemctl --failed --no-legend 2>/dev/null | wc -l | tr -d ' ')\"; \
printf 'listen=%s\\n' \"$(command -v ss >/dev/null 2>&1 && ss -tlnH 2>/dev/null | wc -l | tr -d ' ')\"; \
printf 'conntrack=%s %s\\n' \"$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null)\" \"$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null)\"; \
printf 'timesync=%s\\n' \"$(command -v timedatectl >/dev/null 2>&1 && timedatectl show -p NTPSynchronized --value 2>/dev/null)\"; \
printf 'netdev=%s\\n' \"$(awk 'NR>2{sub(/:/,\"\");if($1!=\"lo\")printf \"%s,%s,%s,%s,%s,%s,%s;\",$1,$2,$4,$5,$10,$12,$13}' /proc/net/dev 2>/dev/null)\"; \
printf 'diskdev=%s\\n' \"$(awk '$3!~/^(loop|ram|dm-|sr)/ && ($6>0||$10>0){printf \"%s,%s,%s;\",$3,$6,$10}' /proc/diskstats 2>/dev/null)\"; \
printf 'sessions=%s\\n' \"$(who 2>/dev/null | awk '{f=\"\";if($NF ~ /^\\(.*\\)$/){f=$NF;gsub(/[()]/,\"\",f)}printf \"%s,%s,%s %s,%s;\",$1,$2,$3,$4,f}')\"; \
printf 'ctxintr=%s\\n' \"$(awk '/^ctxt /{c=$2}/^intr /{i=$2}END{printf \"%d %d\",c,i}' /proc/stat 2>/dev/null)\"; \
printf 'procs=%s\\n' \"$(awk '/^procs_running/{r=$2}/^procs_blocked/{b=$2}END{printf \"%d %d\",r,b}' /proc/stat 2>/dev/null)\"";

/// Pressure Stall Information (PSI) `some` averages over 10/60/300 s windows.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Psi {
    avg10: f64,
    avg60: f64,
    avg300: f64,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Partition {
    mount: String,
    fstype: String,
    used: u64,
    total: u64,
    inodes_used: Option<u64>,
    inodes_total: Option<u64>,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TcpState {
    state: String,
    count: u64,
}

/// One temperature sensor reading from lm-sensors (`sensors -u`).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sensor {
    label: String,
    temp: f64,
    high: Option<f64>,
    crit: Option<f64>,
}

/// CPU time breakdown over the last interval (percentages summing to ~100).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CpuBreakdown {
    user: f64,
    system: f64,
    iowait: f64,
    steal: f64,
    idle: f64,
}

/// One process row for the top-CPU table.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pid: u32,
    user: String,
    cpu: f64,
    mem: f64,
    comm: String,
}

/// Per-interface network: rx/tx bytes-per-second + cumulative error/drop counters.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetIface {
    name: String,
    rx_rate: u64,
    tx_rate: u64,
    rx_errs: u64,
    rx_drop: u64,
    tx_errs: u64,
    tx_drop: u64,
}

/// Per-device disk throughput (bytes/sec) from `/proc/diskstats` sector deltas.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiskDev {
    name: String,
    read_rate: u64,
    write_rate: u64,
}

/// One logged-in session from `who` (tty, origin, login time).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    user: String,
    tty: String,
    from: String,
    login: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsDetail {
    /// Per-core CPU utilization 0–100 (empty on the first poll of a session).
    per_cpu: Vec<f64>,
    mem_total: Option<u64>,
    mem_free: Option<u64>,
    mem_available: Option<u64>,
    mem_buffers: Option<u64>,
    mem_cached: Option<u64>,
    /// Top processes by memory, "name N%" comma-joined.
    top_mem: String,
    partitions: Vec<Partition>,
    /// System-wide open file descriptors vs the `fs.file-max` ceiling.
    file_nr_used: Option<u64>,
    file_nr_max: Option<u64>,
    ulimit_soft: Option<u64>,
    ulimit_hard: Option<u64>,
    psi_cpu: Option<Psi>,
    psi_mem: Option<Psi>,
    psi_io: Option<Psi>,
    tcp: Vec<TcpState>,
    /// Temperature sensors (lm-sensors); empty when `sensors` isn't installed.
    sensors: Vec<Sensor>,
    /// Whether the `sensors` binary exists — lets the UI tell "not installed"
    /// (offer install) apart from "installed but no chips detected".
    sensors_installed: bool,
    /// CPU time split (user/system/iowait/steal/idle %); None on the first poll.
    cpu_breakdown: Option<CpuBreakdown>,
    /// Top processes by CPU (pid/user/cpu/mem/comm).
    top_procs: Vec<Proc>,
    /// Top processes by memory (same shape, sorted by %MEM).
    top_mem_procs: Vec<Proc>,
    /// Failed systemd units / listening TCP sockets / nf_conntrack usage.
    failed_units: Option<u64>,
    listen_ports: Option<u64>,
    conntrack: Option<u64>,
    conntrack_max: Option<u64>,
    /// NTP clock synchronization (timedatectl); None when unknown.
    time_synced: Option<bool>,
    /// Per-interface network and per-device disk throughput + logged-in sessions.
    net_ifaces: Vec<NetIface>,
    disk_devs: Vec<DiskDev>,
    sessions: Vec<Session>,
    /// Context switches / interrupts per second (rate from cumulative counters).
    ctxt_rate: Option<u64>,
    intr_rate: Option<u64>,
    procs_running: Option<u64>,
    procs_blocked: Option<u64>,
}

/// Parse `key=a,b a,b …` per-core jiffies into `(idle, total)` pairs.
fn parse_percpu(raw: &str) -> Vec<(u64, u64)> {
    let Some(line) = raw.lines().find_map(|l| l.strip_prefix("percpu=")) else {
        return Vec::new();
    };
    line.split_whitespace()
        .filter_map(|tok| {
            let (idle, total) = tok.split_once(',')?;
            Some((idle.parse().ok()?, total.parse().ok()?))
        })
        .collect()
}

/// Per-core utilization from previous and current `(idle, total)` jiffies.
/// Cores whose totals didn't advance (or counts changed) yield 0.
fn percpu_delta(prev: &[(u64, u64)], cur: &[(u64, u64)]) -> Vec<f64> {
    if prev.len() != cur.len() {
        return Vec::new();
    }
    cur.iter()
        .zip(prev.iter())
        .map(|(&(ci, ct), &(pi, pt))| {
            let dt = ct.saturating_sub(pt);
            let di = ci.saturating_sub(pi);
            if dt > 0 {
                ((dt - di) as f64 / dt as f64 * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            }
        })
        .collect()
}

/// Parse a `some avg10=x avg60=y avg300=z total=…` PSI line.
fn parse_psi(raw: &str, key: &str) -> Option<Psi> {
    let prefix = format!("{key}=");
    let line = raw.lines().find_map(|l| l.strip_prefix(prefix.as_str()))?;
    if line.trim().is_empty() {
        return None;
    }
    let mut p = Psi::default();
    for tok in line.split_whitespace() {
        if let Some((k, v)) = tok.split_once('=') {
            let val: f64 = v.parse().unwrap_or(0.0);
            match k {
                "avg10" => p.avg10 = val,
                "avg60" => p.avg60 = val,
                "avg300" => p.avg300 = val,
                _ => {}
            }
        }
    }
    Some(p)
}

/// Merge the `parts=` (space/used) and `inodes=` records into partitions, keyed
/// by mount point.
fn parse_partitions(raw: &str) -> Vec<Partition> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("parts="))
        .unwrap_or("");
    let inodes_line = raw
        .lines()
        .find_map(|l| l.strip_prefix("inodes="))
        .unwrap_or("");

    let mut inode_map: HashMap<String, (u64, u64)> = HashMap::new();
    for rec in inodes_line.split(';').filter(|r| !r.is_empty()) {
        let f: Vec<&str> = rec.split(',').collect();
        if f.len() == 3 {
            if let (Ok(total), Ok(used)) = (f[1].parse(), f[2].parse()) {
                inode_map.insert(f[0].to_string(), (used, total));
            }
        }
    }

    let mut out = Vec::new();
    for rec in line.split(';').filter(|r| !r.is_empty()) {
        let f: Vec<&str> = rec.split(',').collect();
        if f.len() != 4 {
            continue;
        }
        let (Ok(total), Ok(used)) = (f[2].parse::<u64>(), f[3].parse::<u64>()) else {
            continue;
        };
        let (inodes_used, inodes_total) = match inode_map.get(f[0]) {
            Some(&(u, t)) => (Some(u), Some(t)),
            None => (None, None),
        };
        out.push(Partition {
            mount: f[0].to_string(),
            fstype: f[1].to_string(),
            used,
            total,
            inodes_used,
            inodes_total,
        });
    }
    out
}

/// Parse the `cpubreak=` aggregate `/proc/stat` jiffies (user nice system idle
/// iowait irq softirq steal) into 8 cumulative counters.
fn parse_cpu_jiffies(raw: &str) -> Option<[u64; 8]> {
    let line = raw.lines().find_map(|l| l.strip_prefix("cpubreak="))?;
    let n: Vec<u64> = line
        .split_whitespace()
        .filter_map(|x| x.parse().ok())
        .collect();
    if n.len() < 8 {
        return None;
    }
    Some([n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7]])
}

/// CPU time breakdown from two jiffy samples. `None` when the interval didn't
/// advance. Percentages: user(+nice), system(+irq+softirq), iowait, steal, idle.
fn cpu_breakdown(prev: &[u64; 8], cur: &[u64; 8]) -> Option<CpuBreakdown> {
    let d: Vec<i64> = (0..8).map(|i| cur[i] as i64 - prev[i] as i64).collect();
    let tot: i64 = d.iter().map(|v| v.max(&0)).sum();
    if tot <= 0 {
        return None;
    }
    let pct = |v: i64| (v.max(0) as f64 / tot as f64) * 100.0;
    Some(CpuBreakdown {
        user: pct(d[0] + d[1]),
        system: pct(d[2] + d[5] + d[6]),
        iowait: pct(d[4]),
        steal: pct(d[7]),
        idle: pct(d[3]),
    })
}

/// Parse a `<key>pid|user|cpu|mem|comm;…` process-table line (e.g. `topcpu=` /
/// `topmemp=`) into process rows.
fn parse_top_procs(raw: &str, key: &str) -> Vec<Proc> {
    let line = raw.lines().find_map(|l| l.strip_prefix(key)).unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 5 {
                return None;
            }
            Some(Proc {
                pid: f[0].trim().parse().ok()?,
                user: f[1].trim().to_string(),
                cpu: f[2].trim().parse().ok()?,
                mem: f[3].trim().parse().ok()?,
                comm: f[4].trim().to_string(),
            })
        })
        .collect()
}

/// Per-device byte rates: for each `(name, a, b)` cumulative counter, return the
/// per-second delta against this session's previous sample (updating it). Devices
/// with no prior sample (first poll) are omitted from the result.
fn dev_rate_map(
    store: &DevSampleStore,
    session_id: &str,
    cur: &[(String, u64, u64)],
) -> HashMap<String, (u64, u64)> {
    let now = Instant::now();
    let mut guard = store.lock().unwrap();
    let prevs = guard.entry(session_id.to_string()).or_default();
    let mut out = HashMap::new();
    let mut next = HashMap::new();
    for (name, a, b) in cur {
        if let Some(&(pa, pb, pt)) = prevs.get(name) {
            let dt = now.duration_since(pt).as_secs_f64();
            if dt > 0.0 {
                let ra = (a.saturating_sub(pa) as f64 / dt) as u64;
                let rb = (b.saturating_sub(pb) as f64 / dt) as u64;
                out.insert(name.clone(), (ra, rb));
            }
        }
        next.insert(name.clone(), (*a, *b, now));
    }
    *prevs = next;
    out
}

/// Parse `netdev=name,rxBytes,rxErrs,rxDrop,txBytes,txErrs,txDrop;…` into raw rows
/// (rates are derived separately from two samples).
#[allow(clippy::type_complexity)]
fn parse_netdev(raw: &str) -> Vec<(String, u64, u64, u64, u64, u64, u64)> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("netdev="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split(',').collect();
            if f.len() != 7 {
                return None;
            }
            let n = |i: usize| f[i].parse::<u64>().ok();
            Some((f[0].to_string(), n(1)?, n(2)?, n(3)?, n(4)?, n(5)?, n(6)?))
        })
        .collect()
}

/// Parse `diskdev=name,readSectors,writeSectors;…` into `(name, readBytes, writeBytes)`
/// (sectors are 512 bytes).
fn parse_diskdev(raw: &str) -> Vec<(String, u64, u64)> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("diskdev="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split(',').collect();
            if f.len() != 3 {
                return None;
            }
            Some((
                f[0].to_string(),
                f[1].parse::<u64>().ok()? * 512,
                f[2].parse::<u64>().ok()? * 512,
            ))
        })
        .collect()
}

/// Parse `sessions=user,tty,login,from;…` into session rows.
fn parse_sessions(raw: &str) -> Vec<Session> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("sessions="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split(',').collect();
            if f.len() != 4 || f[0].is_empty() {
                return None;
            }
            Some(Session {
                user: f[0].to_string(),
                tty: f[1].to_string(),
                login: f[2].trim().to_string(),
                from: f[3].to_string(),
            })
        })
        .collect()
}

/// Parse the `sensors=label,temp,high,crit;…` line into sensor readings. `high`
/// and `crit` are optional (empty field → `None`); records without a numeric temp
/// are skipped.
fn parse_sensors(raw: &str) -> Vec<Sensor> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("sensors="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let mut f = rec.split(',');
            let label = f.next()?.trim().to_string();
            let temp: f64 = f.next()?.parse().ok()?;
            if label.is_empty() {
                return None;
            }
            let high = f.next().and_then(|s| s.parse().ok());
            let crit = f.next().and_then(|s| s.parse().ok());
            Some(Sensor {
                label,
                temp,
                high,
                crit,
            })
        })
        .collect()
}

/// Parse the `tcp=STATE:count …` line into per-state counts.
fn parse_tcp(raw: &str) -> Vec<TcpState> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("tcp="))
        .unwrap_or("");
    line.split_whitespace()
        .filter_map(|tok| {
            let (state, count) = tok.split_once(':')?;
            Some(TcpState {
                state: state.to_string(),
                count: count.parse().ok()?,
            })
        })
        .collect()
}

/// Build the static part of `MetricsDetail` (everything not needing a delta).
fn parse_detail(raw: &str) -> MetricsDetail {
    let mut d = MetricsDetail::default();
    if let Some(line) = raw.lines().find_map(|l| l.strip_prefix("memdetail=")) {
        let n: Vec<u64> = line
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if n.len() == 5 {
            d.mem_total = Some(n[0]);
            d.mem_free = Some(n[1]);
            d.mem_available = Some(n[2]);
            d.mem_buffers = Some(n[3]);
            d.mem_cached = Some(n[4]);
        }
    }
    d.top_mem = raw
        .lines()
        .find_map(|l| l.strip_prefix("topmem="))
        .unwrap_or("")
        .trim()
        .to_string();
    d.partitions = parse_partitions(raw);
    if let Some((used, max)) = parse_pair(raw, "filenr") {
        d.file_nr_used = Some(used);
        d.file_nr_max = Some(max);
    }
    if let Some((soft, hard)) = parse_pair(raw, "ulimit") {
        d.ulimit_soft = Some(soft);
        d.ulimit_hard = Some(hard);
    }
    d.psi_cpu = parse_psi(raw, "psicpu");
    d.psi_mem = parse_psi(raw, "psimem");
    d.psi_io = parse_psi(raw, "psiio");
    d.tcp = parse_tcp(raw);
    d.sensors = parse_sensors(raw);
    d.sensors_installed = raw
        .lines()
        .find_map(|l| l.strip_prefix("sensorsbin="))
        .is_some_and(|s| s.trim() == "1");
    d.top_procs = parse_top_procs(raw, "topcpu=");
    d.top_mem_procs = parse_top_procs(raw, "topmemp=");
    d.failed_units = raw
        .lines()
        .find_map(|l| l.strip_prefix("failed="))
        .and_then(|s| s.trim().parse().ok());
    d.listen_ports = raw
        .lines()
        .find_map(|l| l.strip_prefix("listen="))
        .and_then(|s| s.trim().parse().ok());
    if let Some((c, m)) = parse_pair(raw, "conntrack") {
        d.conntrack = Some(c);
        d.conntrack_max = Some(m);
    }
    d.time_synced = raw
        .lines()
        .find_map(|l| l.strip_prefix("timesync="))
        .and_then(|s| match s.trim() {
            "yes" | "true" | "1" => Some(true),
            "no" | "false" | "0" => Some(false),
            _ => None,
        });
    d.sessions = parse_sessions(raw);
    if let Some((r, b)) = parse_pair(raw, "procs") {
        d.procs_running = Some(r);
        d.procs_blocked = Some(b);
    }
    d
}

/// Probe the active session for detailed metrics (monitoring overlay).
#[tauri::command]
pub async fn fetch_metrics_detail(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<MetricsDetail> {
    let session = match state.sessions.lock().await.get(&session_id).cloned() {
        Some(s) => s,
        None if is_local_session(&state, &session_id) => return Ok(local::collect_detail().await),
        None => return Err(AppError::NoSession),
    };
    let raw = session.run_command(DETAIL_SCRIPT).await?;
    let mut d = parse_detail(&raw);

    // Per-core CPU% needs two samples (per-core jiffies stored per session).
    let cur = parse_percpu(&raw);
    if !cur.is_empty() {
        let mut samples = state.metrics_samples.core_samples.lock().unwrap();
        if let Some(prev) = samples.get(&session_id) {
            d.per_cpu = percpu_delta(prev, &cur);
        }
        samples.insert(session_id.clone(), cur);
    }

    // CPU time breakdown (user/system/iowait/steal/idle) from two jiffy samples.
    if let Some(cur) = parse_cpu_jiffies(&raw) {
        let mut samples = state.metrics_samples.cpu_stat_samples.lock().unwrap();
        if let Some(prev) = samples.get(&session_id) {
            d.cpu_breakdown = cpu_breakdown(prev, &cur);
        }
        samples.insert(session_id.clone(), cur);
    }

    // Per-interface network rates (rx/tx bytes/s) from two samples; error/drop
    // counters are cumulative and carried through as-is.
    let nd = parse_netdev(&raw);
    if !nd.is_empty() {
        let cur: Vec<(String, u64, u64)> = nd.iter().map(|r| (r.0.clone(), r.1, r.4)).collect();
        let rates = dev_rate_map(&state.metrics_samples.iface_samples, &session_id, &cur);
        d.net_ifaces = nd
            .into_iter()
            .map(|(name, _rxb, rx_errs, rx_drop, _txb, tx_errs, tx_drop)| {
                let (rx_rate, tx_rate) = rates.get(&name).copied().unwrap_or((0, 0));
                NetIface {
                    name,
                    rx_rate,
                    tx_rate,
                    rx_errs,
                    rx_drop,
                    tx_errs,
                    tx_drop,
                }
            })
            .collect();
    }

    // Per-device disk throughput (bytes/s) from sector-count deltas.
    let dd = parse_diskdev(&raw);
    if !dd.is_empty() {
        let rates = dev_rate_map(&state.metrics_samples.diskdev_samples, &session_id, &dd);
        d.disk_devs = dd
            .into_iter()
            .filter_map(|(name, _r, _w)| {
                rates.get(&name).map(|&(read_rate, write_rate)| DiskDev {
                    name,
                    read_rate,
                    write_rate,
                })
            })
            .collect();
    }

    // Context-switch / interrupt rates (delta of cumulative counters).
    if let Some(ci) = parse_pair(&raw, "ctxintr") {
        (d.ctxt_rate, d.intr_rate) =
            rate_from(&state.metrics_samples.ctxintr_samples, &session_id, ci);
    }
    Ok(d)
}

/// Distro-aware count of pending package updates + a reboot-required flag. Heavy
/// (reads package caches), so it lives behind its own command and is fetched
/// lazily by the monitoring overlay — never by the status bar.
const PENDING_SCRIPT: &str = r#"
reboot=0; [ -e /var/run/reboot-required ] && reboot=1
mgr=""; up=""; sec=""
if command -v apt-get >/dev/null 2>&1; then
  mgr=apt
  if [ -x /usr/lib/update-notifier/apt-check ]; then
    r=$(/usr/lib/update-notifier/apt-check 2>&1); up=${r%%;*}; sec=${r##*;}
  else
    up=$(LANG=C apt-get -s upgrade 2>/dev/null | grep -c '^Inst')
    sec=$(LANG=C apt-get -s upgrade 2>/dev/null | grep '^Inst' | grep -ic 'security')
  fi
elif command -v dnf >/dev/null 2>&1; then
  mgr=dnf; up=$(dnf -q check-update 2>/dev/null | grep -c '^[a-zA-Z0-9]')
elif command -v yum >/dev/null 2>&1; then
  mgr=yum; up=$(yum -q check-update 2>/dev/null | grep -c '^[a-zA-Z0-9]')
elif command -v checkupdates >/dev/null 2>&1; then
  mgr=pacman; up=$(checkupdates 2>/dev/null | grep -c '.')
elif command -v zypper >/dev/null 2>&1; then
  mgr=zypper; up=$(zypper -q lu 2>/dev/null | grep -c '^v ')
elif command -v apk >/dev/null 2>&1; then
  mgr=apk; up=$(apk version -l '<' 2>/dev/null | grep -c '<')
fi
printf 'mgr=%s\nupdates=%s\nsecurity=%s\nreboot=%s\n' "$mgr" "$up" "$sec" "$reboot"
"#;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdates {
    /// Package manager detected ("apt"/"dnf"/…); empty if none recognized.
    manager: String,
    updates: Option<u64>,
    security: Option<u64>,
    reboot_required: bool,
}

fn parse_pending(raw: &str) -> PendingUpdates {
    let mut p = PendingUpdates::default();
    for line in raw.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim();
        match k {
            "mgr" => p.manager = v.to_string(),
            "updates" => p.updates = v.parse().ok(),
            "security" => p.security = v.parse().ok(),
            "reboot" => p.reboot_required = v == "1",
            _ => {}
        }
    }
    p
}

/// Lazily probe the active session for pending package updates.
#[tauri::command]
pub async fn fetch_pending_updates(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<PendingUpdates> {
    let session = match state.sessions.lock().await.get(&session_id).cloned() {
        Some(s) => s,
        // No package-manager concept for a local dev machine (and none cross-OS):
        // return an empty result so the overlay's "updates" section stays blank.
        None if is_local_session(&state, &session_id) => return Ok(PendingUpdates::default()),
        None => return Err(AppError::NoSession),
    };
    let raw = session.run_command(PENDING_SCRIPT).await?;
    Ok(parse_pending(&raw))
}

/// Optional "extras" probed once when the monitoring overlay opens: NVIDIA GPUs,
/// Docker containers, disk SMART health and the OOM-kill count. Heavy/optional and
/// best-effort (each guarded by `command -v`; SMART needs root, so it populates for
/// root sessions and is empty otherwise) — never part of the per-poll detail probe.
const EXTRAS_SCRIPT: &str = r#"
gpu=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu=$(nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | awk -F', *' '{printf "%s|%s|%s|%s|%s;",$1,$2,$3,$4,$5}')
fi
printf 'gpu=%s\n' "$gpu"
docker=""
if command -v docker >/dev/null 2>&1; then
  docker=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null | awk '{gsub(/%/,"");printf "%s;",$0}')
fi
printf 'docker=%s\n' "$docker"
printf 'oom=%s\n' "$(dmesg 2>/dev/null | grep -ic 'out of memory')"
smart=""
for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
  o=$(smartctl -H -A /dev/$d 2>/dev/null)
  [ -z "$o" ] && continue
  h=$(printf '%s\n' "$o" | awk '/overall-health/{print $NF}')
  t=$(printf '%s\n' "$o" | awk '/Temperature_Celsius/{print $10} /^Temperature:/{print $2}' | head -1)
  p=$(printf '%s\n' "$o" | awk '/Power_On_Hours/{print $10} /Power On Hours/{print $NF}' | head -1)
  smart="$smart$d|$h|$t|$p;"
done
printf 'smart=%s\n' "$smart"
printf 'arch=%s\n' "$(uname -m 2>/dev/null)"
cpumodel=$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null)
[ -z "$cpumodel" ] && cpumodel=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
printf 'cpumodel=%s\n' "$cpumodel"
printf 'cputhreads=%s\n' "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
lc=$(lscpu 2>/dev/null)
cps=$(printf '%s\n' "$lc" | awk -F: '/^Core\(s\) per socket/{gsub(/ /,"",$2);print $2}')
sk=$(printf '%s\n' "$lc" | awk -F: '/^Socket\(s\)/{gsub(/ /,"",$2);print $2}')
printf 'cpusockets=%s\n' "$sk"
if [ -n "$cps" ] && [ -n "$sk" ]; then printf 'cpucores=%s\n' "$((cps*sk))"; else printf 'cpucores=\n'; fi
mhz=$(printf '%s\n' "$lc" | awk -F: '/^CPU max MHz/{gsub(/ /,"",$2);print $2;exit}')
[ -z "$mhz" ] && mhz=$(awk -F': ' '/^cpu MHz/{print $2; exit}' /proc/cpuinfo 2>/dev/null)
printf 'cpumhz=%s\n' "$mhz"
printf 'virt=%s\n' "$(systemd-detect-virt 2>/dev/null)"
printf 'vendor=%s\n' "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"
printf 'product=%s\n' "$(cat /sys/class/dmi/id/product_name 2>/dev/null)"
printf 'boardvendor=%s\n' "$(cat /sys/class/dmi/id/board_vendor 2>/dev/null)"
printf 'boardname=%s\n' "$(cat /sys/class/dmi/id/board_name 2>/dev/null)"
printf 'bios=%s\n' "$(cat /sys/class/dmi/id/bios_version 2>/dev/null)"
"#;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    name: String,
    util: f64,
    /// VRAM used / total in MiB (as reported by nvidia-smi `nounits`).
    mem_used: u64,
    mem_total: u64,
    temp: f64,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockerStat {
    name: String,
    cpu: f64,
    /// Memory usage string, e.g. "1.2GiB / 3.8GiB".
    mem: String,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmartDisk {
    device: String,
    health: String,
    temp: Option<f64>,
    power_on_hours: Option<u64>,
}

/// Static machine spec (Фаза 20.16) — probed once with the extras (never changes),
/// all fields best-effort and **root-free** (missing tool/file → empty → dash).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    /// CPU brand string, e.g. "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz".
    cpu_model: String,
    /// Physical cores (cores-per-socket × sockets) and logical threads.
    cpu_cores: Option<u32>,
    cpu_threads: Option<u32>,
    cpu_sockets: Option<u32>,
    /// Max CPU frequency in MHz (falls back to the current freq when max is absent).
    cpu_mhz: Option<f64>,
    /// CPU architecture from `uname -m`, e.g. "x86_64".
    arch: String,
    /// Hypervisor/container from `systemd-detect-virt` ("none" on bare metal).
    virt: String,
    /// DMI machine identity, e.g. "Dell Inc. PowerEdge R740" (vendor + product).
    machine: String,
    /// DMI baseboard/motherboard, e.g. "ASUSTeK PRIME B550-PLUS" (vendor + name).
    board: String,
    /// DMI BIOS/firmware version.
    bios: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Extras {
    gpus: Vec<Gpu>,
    docker: Vec<DockerStat>,
    smart: Vec<SmartDisk>,
    oom_kills: Option<u64>,
    hardware: Hardware,
}

/// Merge a DMI vendor + name pair (system product or baseboard) into one label,
/// avoiding duplication when the name already carries the vendor (e.g. vendor
/// "QEMU", name "Standard PC …").
fn combine_machine(vendor: &str, name: &str) -> String {
    let (v, p) = (vendor.trim(), name.trim());
    match (v.is_empty(), p.is_empty()) {
        (true, true) => String::new(),
        (true, false) => p.to_string(),
        (false, true) => v.to_string(),
        (false, false) if p.contains(v) => p.to_string(),
        (false, false) => format!("{v} {p}"),
    }
}

fn parse_extras(raw: &str) -> Extras {
    let field = |key: &str| raw.lines().find_map(|l| l.strip_prefix(key)).unwrap_or("");
    let gpus = field("gpu=")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 5 {
                return None;
            }
            Some(Gpu {
                name: f[0].trim().to_string(),
                util: f[1].trim().parse().unwrap_or(0.0),
                mem_used: f[2].trim().parse().unwrap_or(0),
                mem_total: f[3].trim().parse().unwrap_or(0),
                temp: f[4].trim().parse().unwrap_or(0.0),
            })
        })
        .collect();
    let docker = field("docker=")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 3 {
                return None;
            }
            Some(DockerStat {
                name: f[0].trim().to_string(),
                cpu: f[1].trim().parse().unwrap_or(0.0),
                mem: f[2].trim().to_string(),
            })
        })
        .collect();
    let smart = field("smart=")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 4 || f[0].is_empty() {
                return None;
            }
            Some(SmartDisk {
                device: f[0].trim().to_string(),
                health: f[1].trim().to_string(),
                temp: f[2].trim().parse().ok(),
                power_on_hours: f[3].trim().parse().ok(),
            })
        })
        .collect();
    let oom_kills = field("oom=").trim().parse().ok();
    // Collapse repeated whitespace in the CPU brand string (cpuinfo pads it).
    let cpu_model = field("cpumodel=")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let hardware = Hardware {
        cpu_model,
        cpu_cores: field("cpucores=").trim().parse().ok(),
        cpu_threads: field("cputhreads=").trim().parse().ok(),
        cpu_sockets: field("cpusockets=").trim().parse().ok(),
        cpu_mhz: field("cpumhz=").trim().parse().ok(),
        arch: field("arch=").trim().to_string(),
        virt: field("virt=").trim().to_string(),
        machine: combine_machine(field("vendor="), field("product=")),
        board: combine_machine(field("boardvendor="), field("boardname=")),
        bios: field("bios=").trim().to_string(),
    };
    Extras {
        gpus,
        docker,
        smart,
        oom_kills,
        hardware,
    }
}

/// Probe optional extras (GPU/Docker/SMART/OOM) — lazy, once per overlay open.
#[tauri::command]
pub async fn fetch_extras(state: State<'_, AppState>, session_id: String) -> AppResult<Extras> {
    let session = match state.sessions.lock().await.get(&session_id).cloned() {
        Some(s) => s,
        // Local tabs: GPU/Docker/SMART/OOM are server-shaped and skipped, but the
        // static hardware spec (CPU model/cores/arch) fills nicely from sysinfo.
        None if is_local_session(&state, &session_id) => return Ok(local::collect_extras().await),
        None => return Err(AppError::NoSession),
    };
    let raw = session.run_command(EXTRAS_SCRIPT).await?;
    Ok(parse_extras(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_metrics ─────────────────────────────────────────────────────────
    #[test]
    fn parse_metrics_full_linux_sample() {
        let raw = "os=Linux\n\
                   host=web01\n\
                   user=root\n\
                   pretty=Ubuntu 24.04 LTS\n\
                   load=0.15 0.20 0.30\n\
                   mem=1048576 4194304\n\
                   disk=2097152 10485760\n\
                   cpustat=100 0 50 850 0 0 0";
        let m = parse_metrics(raw);
        assert_eq!(m.os, "Linux");
        assert_eq!(m.hostname, "web01");
        assert_eq!(m.user, "root");
        assert_eq!(m.pretty_name, "Ubuntu 24.04 LTS");
        assert_eq!(m.load1, Some(0.15));
        assert_eq!(m.load5, Some(0.20));
        assert_eq!(m.load15, Some(0.30));
        assert_eq!(m.mem_used, Some(1048576));
        assert_eq!(m.mem_total, Some(4194304));
        assert_eq!(m.disk_used, Some(2097152));
        assert_eq!(m.disk_total, Some(10485760));
    }

    #[test]
    fn parse_metrics_falls_back_pretty_to_os() {
        // macOS without /etc/os-release: pretty is empty, should mirror os.
        let m = parse_metrics("os=Darwin\nhost=mac\npretty=\n");
        assert_eq!(m.pretty_name, "Darwin");
    }

    #[test]
    fn parse_metrics_ignores_garbage_and_blanks() {
        let m = parse_metrics("garbage line\n\nload=notanumber\nmem=\n=oops\nunknown=1");
        assert_eq!(m.load1, None);
        assert_eq!(m.mem_used, None);
        assert!(m.os.is_empty());
    }

    // ── parse_cpustat ─────────────────────────────────────────────────────────
    #[test]
    fn parse_cpustat_idle_and_total() {
        // user nice system idle iowait …
        let (idle, total) = parse_cpustat("cpustat=100 0 50 800 50 0 0").unwrap();
        assert_eq!(idle, 850); // idle + iowait
        assert_eq!(total, 1000);
    }

    #[test]
    fn parse_cpustat_missing_or_short_is_none() {
        assert!(parse_cpustat("os=Linux").is_none());
        assert!(parse_cpustat("cpustat=1 2 3").is_none()); // < 5 fields
    }

    // ── parse_net ─────────────────────────────────────────────────────────────
    #[test]
    fn parse_net_reads_rx_tx() {
        let (rx, tx) = parse_net("cpustat=1 2\nnet=12345 6789").unwrap();
        assert_eq!(rx, 12345);
        assert_eq!(tx, 6789);
    }

    #[test]
    fn parse_net_missing_or_short_is_none() {
        assert!(parse_net("os=Linux").is_none());
        assert!(parse_net("net=42").is_none()); // < 2 fields
    }

    #[test]
    fn parse_pair_reads_named_counters() {
        let (r, w) = parse_pair("diskio=1000 2000\nnet=5 6", "diskio").unwrap();
        assert_eq!((r, w), (1000, 2000));
        assert!(parse_pair("diskio=1", "diskio").is_none()); // < 2 fields
        assert!(parse_pair("net=1 2", "diskio").is_none()); // wrong key
    }

    #[test]
    fn parse_metrics_reads_extended_fields() {
        let m = parse_metrics(
            "uptime=90061\nswap=1024 4096\nusers=alice bob \nip=10.0.0.5\n\
             topproc=node 87%\ncputemp=56\nnetconns=42\nkernel=6.1.0\nstime=14:05 UTC",
        );
        assert_eq!(m.uptime_secs, Some(90061));
        assert_eq!(m.swap_used, Some(1024));
        assert_eq!(m.swap_total, Some(4096));
        assert_eq!(m.users, "alice bob");
        assert_eq!(m.ip, "10.0.0.5");
        assert_eq!(m.top_proc, "node 87%");
        assert_eq!(m.cpu_temp, Some(56.0));
        assert_eq!(m.net_conns, Some(42));
        assert_eq!(m.kernel, "6.1.0");
        assert_eq!(m.server_time, "14:05 UTC");
    }

    // ── detailed metrics (monitoring overlay) ─────────────────────────────────
    #[test]
    fn parse_percpu_reads_idle_total_pairs() {
        let v = parse_percpu("percpu=100,1000 200,2000 \nfoo=bar");
        assert_eq!(v, vec![(100, 1000), (200, 2000)]);
        assert!(parse_percpu("os=Linux").is_empty());
    }

    #[test]
    fn percpu_delta_computes_busy_percentage() {
        // core0: total +100, idle +20 → 80% busy. core1: total +100, idle +100 → 0%.
        let prev = [(100, 1000), (500, 5000)];
        let cur = [(120, 1100), (600, 5100)];
        let pct = percpu_delta(&prev, &cur);
        assert_eq!(pct, vec![80.0, 0.0]);
        // Mismatched core counts → empty (a CPU hotplug between polls).
        assert!(percpu_delta(&prev, &[(1, 2)]).is_empty());
    }

    #[test]
    fn parse_psi_reads_some_averages() {
        let p = parse_psi(
            "psicpu=avg10=1.50 avg60=0.20 avg300=0.05 total=999",
            "psicpu",
        )
        .unwrap();
        assert_eq!((p.avg10, p.avg60, p.avg300), (1.50, 0.20, 0.05));
        // Empty line (kernel without PSI) → None.
        assert!(parse_psi("psicpu=", "psicpu").is_none());
        assert!(parse_psi("os=Linux", "psicpu").is_none());
    }

    #[test]
    fn parse_partitions_merges_space_and_inodes() {
        let raw = "parts=/,ext4,10485760,5242880;/boot,vfat,1048576,524288;\n\
                   inodes=/,655360,123456;\n";
        let parts = parse_partitions(raw);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].mount, "/");
        assert_eq!(parts[0].fstype, "ext4");
        assert_eq!(parts[0].total, 10485760);
        assert_eq!(parts[0].used, 5242880);
        assert_eq!(parts[0].inodes_total, Some(655360));
        assert_eq!(parts[0].inodes_used, Some(123456));
        // /boot has no inode record → None, not a crash.
        assert_eq!(parts[1].mount, "/boot");
        assert_eq!(parts[1].inodes_total, None);
    }

    #[test]
    fn parse_tcp_counts_states() {
        let t = parse_tcp("tcp=ESTAB:12 LISTEN:8 TIME-WAIT:3 \n");
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].state, "ESTAB");
        assert_eq!(t[0].count, 12);
        assert!(parse_tcp("os=Linux").is_empty());
    }

    #[test]
    fn parse_netdev_diskdev_sessions_rows() {
        let nd = parse_netdev("netdev=eth0,1000,1,2,500,3,4;wlan0,9,0,0,8,0,0;");
        assert_eq!(nd.len(), 2);
        assert_eq!(nd[0], ("eth0".into(), 1000, 1, 2, 500, 3, 4));

        // Sectors → bytes (×512).
        let dd = parse_diskdev("diskdev=sda,10,20;");
        assert_eq!(dd, vec![("sda".to_string(), 5120, 10240)]);

        let s = parse_sessions(
            "sessions=root,pts/0,2026-06-29 14:00,10.0.0.5;bob,tty1,2026-06-29 09:00,;",
        );
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].user, "root");
        assert_eq!(s[0].from, "10.0.0.5");
        assert_eq!(s[1].from, "");
        assert!(parse_netdev("os=Linux").is_empty());
    }

    #[test]
    fn dev_rate_map_computes_per_second_deltas() {
        let store: DevSampleStore = Mutex::new(HashMap::new());
        // First call: no prior sample → empty.
        let r1 = dev_rate_map(&store, "s1", &[("eth0".into(), 1000, 2000)]);
        assert!(r1.is_empty());
        // Backdate the stored sample by 1s so the next delta yields a rate.
        {
            let mut g = store.lock().unwrap();
            let e = g.get_mut("s1").unwrap().get_mut("eth0").unwrap();
            e.2 -= std::time::Duration::from_secs(1);
        }
        let r2 = dev_rate_map(&store, "s1", &[("eth0".into(), 1500, 2400)]);
        let (rx, tx) = r2["eth0"];
        assert!((490..=510).contains(&rx), "rx ~500, got {rx}");
        assert!((390..=410).contains(&tx), "tx ~400, got {tx}");
    }

    #[test]
    fn cpu_breakdown_splits_user_system_iowait_steal() {
        // prev → cur: 100 user, 50 system, 20 iowait, 30 steal, 800 idle ticks.
        let prev = [0u64, 0, 0, 0, 0, 0, 0, 0];
        let cur = [100u64, 0, 50, 800, 20, 0, 0, 30];
        let b = cpu_breakdown(&prev, &cur).unwrap();
        assert_eq!(b.user.round(), 10.0);
        assert_eq!(b.system.round(), 5.0);
        assert_eq!(b.iowait.round(), 2.0);
        assert_eq!(b.steal.round(), 3.0);
        assert_eq!(b.idle.round(), 80.0);
        // No advance → None.
        assert!(cpu_breakdown(&cur, &cur).is_none());
    }

    #[test]
    fn parse_top_procs_reads_pipe_records() {
        let raw = "topcpu=1234|root|12.5|3.1|nginx;5678|www|4.0|1.2|php-fpm;\n\
                   topmemp=99|postgres|2.0|41.0|postgres;";
        let p = parse_top_procs(raw, "topcpu=");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].pid, 1234);
        assert_eq!(p[0].user, "root");
        assert_eq!(p[0].cpu, 12.5);
        assert_eq!(p[0].comm, "nginx");
        // Same parser drives the by-memory table via its own key.
        let m = parse_top_procs(raw, "topmemp=");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].comm, "postgres");
        assert_eq!(m[0].mem, 41.0);
        assert!(parse_top_procs("os=Linux", "topcpu=").is_empty());
    }

    #[test]
    fn parse_detail_reads_health_scalars() {
        let raw = "failed=2\nlisten=9\nconntrack=120 65536\ntimesync=yes\n";
        let d = parse_detail(raw);
        assert_eq!(d.failed_units, Some(2));
        assert_eq!(d.listen_ports, Some(9));
        assert_eq!(d.conntrack, Some(120));
        assert_eq!(d.conntrack_max, Some(65536));
        assert_eq!(d.time_synced, Some(true));
        // Empty/absent → None.
        let e = parse_detail("timesync=\nfailed=\n");
        assert_eq!(e.time_synced, None);
        assert_eq!(e.failed_units, None);
    }

    #[test]
    fn parse_sensors_reads_label_temp_high_crit() {
        let raw = "sensors=Package id 0,45,84,100;Core 0,43,,100;Composite,35.85,,88.85;";
        let s = parse_sensors(raw);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].label, "Package id 0");
        assert_eq!(s[0].temp, 45.0);
        assert_eq!(s[0].high, Some(84.0));
        assert_eq!(s[0].crit, Some(100.0));
        // Empty `high` field → None.
        assert_eq!(s[1].label, "Core 0");
        assert_eq!(s[1].high, None);
        assert_eq!(s[1].crit, Some(100.0));
        assert_eq!(s[2].temp, 35.85);
        // No sensors line → empty.
        assert!(parse_sensors("os=Linux").is_empty());
    }

    #[test]
    fn parse_detail_reads_mem_filenr_ulimit_and_procs() {
        let raw = "memdetail=8000 1000 4000 200 2000\n\
                   topmem=node 12%, postgres 8%\n\
                   filenr=1536 9223372036854775807\n\
                   ulimit=1024 524288\n\
                   procs=2 0\n";
        let d = parse_detail(raw);
        assert_eq!(d.mem_total, Some(8000));
        assert_eq!(d.mem_available, Some(4000));
        assert_eq!(d.mem_cached, Some(2000));
        assert_eq!(d.top_mem, "node 12%, postgres 8%");
        assert_eq!(d.file_nr_used, Some(1536));
        assert_eq!(d.file_nr_max, Some(9223372036854775807));
        assert_eq!(d.ulimit_soft, Some(1024));
        assert_eq!(d.ulimit_hard, Some(524288));
        assert_eq!(d.procs_running, Some(2));
        assert_eq!(d.procs_blocked, Some(0));
    }

    // The metrics scripts are shell with awk embedded inside Rust string escapes;
    // a stray backslash silently breaks awk at runtime. Run them through `sh` on
    // the dev machine to catch quoting regressions (output is /proc-dependent, so
    // we only assert the keys are emitted and the shell exits cleanly).
    #[test]
    fn detail_script_runs_in_a_shell_and_emits_keys() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(DETAIL_SCRIPT)
            .output()
            .expect("spawn sh");
        assert!(out.status.success(), "DETAIL_SCRIPT exited non-zero");
        let text = String::from_utf8_lossy(&out.stdout);
        for key in [
            "percpu=",
            "memdetail=",
            "parts=",
            "filenr=",
            "ulimit=",
            "tcp=",
            "sensors=",
            "cpubreak=",
            "topcpu=",
            "topmemp=",
            "failed=",
            "listen=",
            "conntrack=",
            "timesync=",
            "netdev=",
            "diskdev=",
            "sessions=",
        ] {
            assert!(text.contains(key), "DETAIL_SCRIPT missing {key}: {text}");
        }
    }

    #[test]
    fn pending_script_runs_in_a_shell_and_emits_keys() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(PENDING_SCRIPT)
            .output()
            .expect("spawn sh");
        assert!(out.status.success(), "PENDING_SCRIPT exited non-zero");
        let text = String::from_utf8_lossy(&out.stdout);
        for key in ["mgr=", "updates=", "security=", "reboot="] {
            assert!(text.contains(key), "PENDING_SCRIPT missing {key}: {text}");
        }
    }

    #[test]
    fn extras_script_runs_in_a_shell_and_emits_keys() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(EXTRAS_SCRIPT)
            .output()
            .expect("spawn sh");
        assert!(out.status.success(), "EXTRAS_SCRIPT exited non-zero");
        let text = String::from_utf8_lossy(&out.stdout);
        for key in [
            "gpu=",
            "docker=",
            "oom=",
            "smart=",
            "arch=",
            "cpumodel=",
            "cputhreads=",
            "cpucores=",
            "cpusockets=",
            "cpumhz=",
            "virt=",
            "vendor=",
            "product=",
            "boardvendor=",
            "boardname=",
            "bios=",
        ] {
            assert!(text.contains(key), "EXTRAS_SCRIPT missing {key}: {text}");
        }
    }

    #[test]
    fn parse_extras_reads_gpu_docker_smart_oom() {
        let raw = "gpu=GeForce RTX 4090|35|1024|24576|61;\n\
                   docker=web|12.5|1.2GiB / 3.8GiB;db|3.0|512MiB / 2GiB;\n\
                   oom=2\n\
                   smart=sda|PASSED|38|12345;nvme0n1|PASSED||678;";
        let e = parse_extras(raw);
        assert_eq!(e.gpus.len(), 1);
        assert_eq!(e.gpus[0].name, "GeForce RTX 4090");
        assert_eq!(e.gpus[0].util, 35.0);
        assert_eq!(e.gpus[0].mem_total, 24576);
        assert_eq!(e.docker.len(), 2);
        assert_eq!(e.docker[0].name, "web");
        assert_eq!(e.docker[0].cpu, 12.5);
        assert_eq!(e.docker[0].mem, "1.2GiB / 3.8GiB");
        assert_eq!(e.oom_kills, Some(2));
        assert_eq!(e.smart.len(), 2);
        assert_eq!(e.smart[0].device, "sda");
        assert_eq!(e.smart[0].health, "PASSED");
        assert_eq!(e.smart[0].temp, Some(38.0));
        assert_eq!(e.smart[0].power_on_hours, Some(12345));
        // Missing temp field → None.
        assert_eq!(e.smart[1].temp, None);
        assert_eq!(e.smart[1].power_on_hours, Some(678));
        // Empty input → all empty.
        let empty = parse_extras("gpu=\ndocker=\noom=\nsmart=\n");
        assert!(empty.gpus.is_empty() && empty.docker.is_empty() && empty.smart.is_empty());
        assert_eq!(empty.oom_kills, None);
    }

    #[test]
    fn parse_extras_reads_hardware() {
        let raw = "gpu=\ndocker=\noom=\nsmart=\n\
                   arch=x86_64\n\
                   cpumodel=Intel(R)  Xeon(R) CPU E5-2680 v4  @ 2.40GHz\n\
                   cputhreads=16\ncpucores=8\ncpusockets=1\ncpumhz=3300.00\n\
                   virt=kvm\nvendor=Dell Inc.\nproduct=PowerEdge R740\n\
                   boardvendor=Dell Inc.\nboardname=0YWR7D\nbios=2.8.1\n";
        let h = parse_extras(raw).hardware;
        // Repeated whitespace in the brand string is collapsed.
        assert_eq!(h.cpu_model, "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz");
        assert_eq!(h.cpu_cores, Some(8));
        assert_eq!(h.cpu_threads, Some(16));
        assert_eq!(h.cpu_sockets, Some(1));
        assert_eq!(h.cpu_mhz, Some(3300.0));
        assert_eq!(h.arch, "x86_64");
        assert_eq!(h.virt, "kvm");
        assert_eq!(h.machine, "Dell Inc. PowerEdge R740");
        assert_eq!(h.board, "Dell Inc. 0YWR7D");
        assert_eq!(h.bios, "2.8.1");
        // Missing/empty hardware → defaults (empty strings, None numbers).
        let bare = parse_extras("gpu=\ndocker=\noom=\nsmart=\n").hardware;
        assert_eq!(bare.cpu_model, "");
        assert_eq!(bare.cpu_cores, None);
        assert_eq!(bare.arch, "");
        assert_eq!(bare.machine, "");
    }

    #[test]
    fn combine_machine_dedupes_vendor() {
        assert_eq!(
            combine_machine("Dell Inc.", "PowerEdge R740"),
            "Dell Inc. PowerEdge R740"
        );
        // Product already carries the vendor → no duplication.
        assert_eq!(
            combine_machine("QEMU", "QEMU Standard PC"),
            "QEMU Standard PC"
        );
        assert_eq!(combine_machine("", "MacBookPro18,1"), "MacBookPro18,1");
        assert_eq!(combine_machine("LENOVO", ""), "LENOVO");
        assert_eq!(combine_machine("", ""), "");
    }

    #[test]
    fn parse_pending_reads_manager_and_counts() {
        let p = parse_pending("mgr=apt\nupdates=12\nsecurity=3\nreboot=1\n");
        assert_eq!(p.manager, "apt");
        assert_eq!(p.updates, Some(12));
        assert_eq!(p.security, Some(3));
        assert!(p.reboot_required);
        // No recognized manager → empty/None, reboot false.
        let none = parse_pending("mgr=\nupdates=\nsecurity=\nreboot=0\n");
        assert!(none.manager.is_empty());
        assert_eq!(none.updates, None);
        assert!(!none.reboot_required);
    }

    // ── MetricsSamples ─────────────────────────────────────────────────────────
    #[test]
    fn clear_session_removes_every_sample_store() {
        let s = MetricsSamples::default();
        let now = Instant::now();
        // Seed one entry per store for the same session id.
        s.cpu_samples.lock().unwrap().insert("sid".into(), (1, 2));
        s.net_samples
            .lock()
            .unwrap()
            .insert("sid".into(), (1, 2, now));
        s.disk_samples
            .lock()
            .unwrap()
            .insert("sid".into(), (1, 2, now));
        s.core_samples
            .lock()
            .unwrap()
            .insert("sid".into(), vec![(1, 2)]);
        s.cpu_stat_samples
            .lock()
            .unwrap()
            .insert("sid".into(), [0; 8]);
        s.iface_samples
            .lock()
            .unwrap()
            .insert("sid".into(), HashMap::new());
        s.diskdev_samples
            .lock()
            .unwrap()
            .insert("sid".into(), HashMap::new());
        s.ctxintr_samples
            .lock()
            .unwrap()
            .insert("sid".into(), (1, 2, now));

        s.clear_session("sid");

        // Every store must be empty — including net/disk, which the old cleanup missed.
        assert!(s.cpu_samples.lock().unwrap().is_empty());
        assert!(s.net_samples.lock().unwrap().is_empty());
        assert!(s.disk_samples.lock().unwrap().is_empty());
        assert!(s.core_samples.lock().unwrap().is_empty());
        assert!(s.cpu_stat_samples.lock().unwrap().is_empty());
        assert!(s.iface_samples.lock().unwrap().is_empty());
        assert!(s.diskdev_samples.lock().unwrap().is_empty());
        assert!(s.ctxintr_samples.lock().unwrap().is_empty());
    }
}
