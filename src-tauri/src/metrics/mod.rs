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
use crate::locks::Locked;
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
    state.local_ptys.locked().contains_key(session_id)
}

/// Per-session, per-device cumulative `(a, b)` counters + sample instant, used for
/// per-interface network and per-device disk throughput deltas.
type DevSampleStore = Mutex<HashMap<String, HashMap<String, (u64, u64, Instant)>>>;

/// Per-session, per-device `/proc/diskstats` operation and time counters + sample
/// instant, for device utilization and average request latency.
type DiskTickStore = Mutex<HashMap<String, HashMap<String, (DiskTicks, Instant)>>>;

/// Per-session, per-process (CPU ticks used, start time) + sample instant: the
/// start time tells a reused pid from the process it was.
type ProcTickStore = Mutex<HashMap<String, (HashMap<u32, (u64, u64)>, Instant)>>;

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
    /// Last cumulative swap (pages in, pages out) from `/proc/vmstat` per session.
    vmstat_samples: Mutex<HashMap<String, (u64, u64, Instant)>>,
    /// Last per-device I/O counters (ops, ticks) per session, for utilization and latency.
    diskstat_samples: DiskTickStore,
    /// Last per-process CPU ticks per session, for every process's current CPU%.
    proc_samples: ProcTickStore,
    /// The same, read by the status bar's own probe: kept apart so the two probes
    /// of one tick do not measure each other over a fraction of a second.
    top_samples: ProcTickStore,
}

impl MetricsSamples {
    /// Drop **all** of a session's samples when it disconnects. The old inline
    /// cleanup missed `net_samples`/`disk_samples`, leaking one entry per closed
    /// session; grouping the stores here lets us clear every one in a single place.
    pub fn clear_session(&self, id: &str) {
        self.cpu_samples.locked().remove(id);
        self.net_samples.locked().remove(id);
        self.disk_samples.locked().remove(id);
        self.core_samples.locked().remove(id);
        self.cpu_stat_samples.locked().remove(id);
        self.iface_samples.locked().remove(id);
        self.diskdev_samples.locked().remove(id);
        self.ctxintr_samples.locked().remove(id);
        self.vmstat_samples.locked().remove(id);
        self.diskstat_samples.locked().remove(id);
        self.proc_samples.locked().remove(id);
        self.top_samples.locked().remove(id);
    }
}

// ── Remote metrics (bottom status bar) ─────────────────────────────────────────

/// One lightweight, portable shell snippet that prints `key=value` lines. Every
/// field is guarded so a missing tool/file just yields an empty value (which the
/// UI renders as a dash) rather than failing the whole probe.
///
/// It reports **raw** readings only; anything derived from them ("used" memory
/// and swap) is computed in [`mem_used`] / [`swap_used_and_total`], never here —
/// see those for why a subtraction must not happen on the host. `mem` ships the
/// `/proc/meminfo` fields labelled (`MemTotal:<kB> …`) so a field the kernel lacks
/// is simply absent rather than a zero that would read as a measurement. `free`
/// ships the host's own `free -b` header and `Mem:` row verbatim (see
/// [`parse_free`]): "used" is whatever that tool says, because admins compare
/// against it and its definition differs between procps versions.
const METRICS_SCRIPT: &str = "\
printf 'os=%s\\n' \"$(uname -s 2>/dev/null)\"; \
printf 'host=%s\\n' \"$(hostname 2>/dev/null)\"; \
printf 'user=%s\\n' \"$(id -un 2>/dev/null || whoami 2>/dev/null)\"; \
printf 'pretty=%s\\n' \"$( ( . /etc/os-release 2>/dev/null && printf %s \"$PRETTY_NAME\" ) || ( sw_vers -productName 2>/dev/null | tr -d '\\n' ) )\"; \
printf 'load=%s\\n' \"$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)\"; \
printf 'mem=%s\\n' \"$(awk '/^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SReclaimable):/{printf \"%s%s \",$1,$2}' /proc/meminfo 2>/dev/null)\"; \
printf 'free=%s\\n' \"$(LC_ALL=C free -b 2>/dev/null | awk 'NR==1||/^Mem:/' | tr '\\n' '|')\"; \
printf 'disk=%s\\n' \"$(df -kP / 2>/dev/null | awk 'NR==2{printf \"%d %d\",$3*1024,$2*1024}')\"; \
awk '/^cpu /{sub(/^cpu +/,\"\"); printf \"cpustat=%s\\n\",$0} /^cpu[0-9]/{n++} END{if(n)printf \"ncpu=%d\\n\",n}' /proc/stat 2>/dev/null; \
printf 'net=%s\\n' \"$(awk 'NR>2{sub(/:/,\"\",$1); if($1!=\"lo\"){rx+=$2; tx+=$10}} END{printf \"%d %d\",rx,tx}' /proc/net/dev 2>/dev/null)\"; \
printf 'uptime=%s\\n' \"$(cut -d. -f1 /proc/uptime 2>/dev/null)\"; \
printf 'swap=%s\\n' \"$(awk '/SwapTotal/{t=$2}/SwapFree/{f=$2}END{if(t>0)printf \"%d %d\",t*1024,f*1024}' /proc/meminfo 2>/dev/null)\"; \
printf 'diskio=%s\\n' \"$(awk '$3 ~ /^(sd|nvme|vd|xvd|hd)[a-z0-9]*$/ {r+=$6; w+=$10} END{printf \"%d %d\",r*512,w*512}' /proc/diskstats 2>/dev/null)\"; \
printf 'users=%s\\n' \"$(who 2>/dev/null | awk '{print $1}' | sort -u | tr '\\n' ' ')\"; \
printf 'ip=%s\\n' \"$(hostname -I 2>/dev/null | awk '{print $1}')\"; \
if [ -r /proc/self/stat ]; then \
printf 'clk=%s\\n' \"$(getconf CLK_TCK 2>/dev/null)\"; \
printf 'topticks=%s\\n' \"$(awk '{c=$0; sub(/^[^(]*\\(/,\"\",c); sub(/\\) [^)]*$/,\"\",c); r=$0; sub(/^.*\\) /,\"\",r); split(r,a,\" \"); printf \"%s %s %s %s %s\\036\",$1,a[12],a[13],a[20],c}' /proc/[0-9]*/stat 2>/dev/null)\"; \
else printf 'topproc=%s\\n' \"$(ps -eo pcpu=,comm= 2>/dev/null | sort -rn | head -3 | awk '{printf \"%s %d%%, \",$2,$1}' | sed 's/, $//')\"; fi; \
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
    /// Logical CPUs (the `cpuN` lines of `/proc/stat`) — the ceiling a load
    /// average is read against. `None` when the host has no `/proc/stat`.
    cpu_count: Option<u32>,
}

/// The `/proc/meminfo` fields the status bar needs, in bytes. Each is optional:
/// a field the kernel does not report (`MemAvailable` only exists since 3.14)
/// stays `None` instead of becoming a zero that would read as a measurement.
#[derive(Debug, Default, PartialEq)]
struct MemInfo {
    total: Option<u64>,
    available: Option<u64>,
    free: Option<u64>,
    buffers: Option<u64>,
    cached: Option<u64>,
    sreclaimable: Option<u64>,
}

/// Parse the `mem=` probe value: `MemTotal:<kB> MemAvailable:<kB> …`.
fn parse_meminfo(value: &str) -> MemInfo {
    let mut m = MemInfo::default();
    for pair in value.split_whitespace() {
        let Some((key, kb)) = pair.split_once(':') else {
            continue;
        };
        let Some(bytes) = kb.parse::<u64>().ok().and_then(|v| v.checked_mul(1024)) else {
            continue;
        };
        let slot = match key {
            "MemTotal" => &mut m.total,
            "MemAvailable" => &mut m.available,
            "MemFree" => &mut m.free,
            "Buffers" => &mut m.buffers,
            "Cached" => &mut m.cached,
            "SReclaimable" => &mut m.sreclaimable,
            _ => continue,
        };
        *slot = Some(bytes);
    }
    m
}

/// What the host's own `free -b` reports, from the `free=` probe value: its
/// header line and `Mem:` row joined by `|`.
///
/// "Used" has no single definition, and `free` itself changed its mind: OL 8's
/// procps-ng 3.3.15 prints total − free − buff/cache, OL 9's 3.3.17 prints
/// total − available. On a 15 GiB OL 8 host that is 6.5 GiB against 7.7 GiB —
/// the gap being mostly `shared` (tmpfs, database shared memory), which sits in
/// buff/cache yet cannot be reclaimed. An admin checks the status bar against
/// `free -h` on that very host, so the host's `free` is the reference.
///
/// It is trusted only when unambiguous, otherwise [`mem_used`] takes over:
/// - columns are found by **name**, and only in the modern layout, the one with
///   an `available` column (procps-ng ≥ 3.3.10, current busybox). In the legacy
///   `buffers`/`cached` layout the `Mem:` "used" still counts the page cache;
///   the figure admins read there was on a separate `-/+ buffers/cache` line;
/// - the row must have exactly one field per header column: busybox fuses
///   columns once a number outgrows its width (seen in the wild:
///   `1252918476818446744068331418624`, `total` glued to an underflowed `used`);
/// - `used` must not exceed `total`.
#[derive(Debug, PartialEq)]
struct FreeMem {
    total: u64,
    used: u64,
}

fn parse_free(value: &str) -> Option<FreeMem> {
    let mut lines = value.split('|');
    let header: Vec<&str> = lines.next()?.split_whitespace().collect();
    let row: Vec<&str> = lines
        .find(|l| l.trim_start().starts_with("Mem:"))?
        .split_whitespace()
        .skip(1)
        .collect();
    if row.len() != header.len() || !header.contains(&"available") {
        return None;
    }
    let column = |name: &str| {
        let i = header.iter().position(|h| *h == name)?;
        row[i].parse::<u64>().ok()
    };
    let (total, used) = (column("total")?, column("used")?);
    (used <= total).then_some(FreeMem { total, used })
}

/// Used memory computed from `/proc/meminfo`, for hosts whose `free` is absent or
/// untrustworthy (see [`parse_free`]). Follows current procps-ng — OL 9's 3.3.17
/// and 4.x — so the fallback agrees with the modern tool:
///
/// - `MemTotal − MemAvailable` normally;
/// - `MemTotal − MemFree` when `MemAvailable` exceeds the total. It is an
///   estimate (`si_mem_available()`, floored at zero, never capped), and some
///   hosts report it wildly off: a real OL 9.8 VM gave **61.2 GiB available on a
///   7.3 GiB machine** while it was swapping; lxcfs and ballooning do the same.
///   procps-ng then treats available as free, and so do we;
/// - kernels without `MemAvailable` (< 3.14) get the figure tools of that era
///   showed: total − free − buffers − reclaimable cache, or total − free if that
///   underflows.
///
/// v1.0.15–v1.0.19 clamped the distorted case to zero ("more available than total
/// means nothing is in use"): the VM above read "0 MiB used" next to 212 MiB of
/// swap in use — a plausible stand-in for an unknown, which principle 5 forbids.
/// v1.0.20 used the old formula there and claimed that was OL 9's `free`; it is
/// OL 8's. Verified against both real binaries on a substituted `/proc/meminfo`.
fn mem_used(m: &MemInfo) -> Option<u64> {
    let total = m.total?;
    match m.available {
        Some(available) if available <= total => Some(total - available),
        Some(_) => Some(total.saturating_sub(m.free?)),
        None => {
            let free = m.free?;
            let cache = [m.buffers, m.cached, m.sreclaimable]
                .into_iter()
                .flatten()
                .fold(0u64, u64::saturating_add);
            Some(
                total
                    .checked_sub(free.saturating_add(cache))
                    .unwrap_or_else(|| total.saturating_sub(free)),
            )
        }
    }
}

/// Split the `swap=` probe value (`"<total> <free>"`, bytes) into `(used, total)`.
///
/// The subtraction is ours, not awk's: a difference computed on the host goes
/// negative on distorted input and `u64` parsing then drops it silently. Swap
/// has no second opinion to fall back on (unlike memory, see [`mem_used`]), so
/// free exceeding total — or missing — yields `None` ("unknown") rather than a
/// clamped zero or "all of it".
fn swap_used_and_total(value: &str) -> (Option<u64>, Option<u64>) {
    let mut it = value.split_whitespace();
    let total = it.next().and_then(|v| v.parse::<u64>().ok());
    let free = it.next().and_then(|v| v.parse::<u64>().ok());
    (total.zip(free).and_then(|(t, f)| t.checked_sub(f)), total)
}

fn parse_metrics(raw: &str) -> Metrics {
    let mut m = Metrics::default();
    let mut mem_info = MemInfo::default();
    let mut host_free = None;
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
            "mem" => mem_info = parse_meminfo(value),
            "free" => host_free = parse_free(value),
            "disk" => {
                let mut it = value.split_whitespace();
                m.disk_used = it.next().and_then(|v| v.parse().ok());
                m.disk_total = it.next().and_then(|v| v.parse().ok());
            }
            "uptime" => m.uptime_secs = value.parse().ok(),
            "swap" => (m.swap_used, m.swap_total) = swap_used_and_total(value),
            "users" => m.users = value.to_string(),
            "ip" => m.ip = value.to_string(),
            "topproc" => m.top_proc = value.to_string(),
            "cputemp" => m.cpu_temp = value.parse().ok(),
            "netconns" => m.net_conns = value.parse().ok(),
            "kernel" => m.kernel = value.to_string(),
            "stime" => m.server_time = value.to_string(),
            "ncpu" => m.cpu_count = value.parse().ok().filter(|&n: &u32| n > 0),
            _ => {}
        }
    }
    if m.pretty_name.is_empty() {
        m.pretty_name = m.os.clone();
    }
    // The host's `free` wins, but only if it describes the same memory as
    // /proc/meminfo: busybox reads sysinfo(), which under lxcfs is the *host*
    // while /proc/meminfo is the container. procps reads /proc/meminfo, so its
    // total matches MemTotal to the byte.
    let host_free = host_free.filter(|f: &FreeMem| mem_info.total.is_none_or(|t| t == f.total));
    m.mem_total = mem_info.total.or(host_free.as_ref().map(|f| f.total));
    m.mem_used = host_free.map(|f| f.used).or_else(|| mem_used(&mem_info));
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
    let mut s = samples.locked();
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
        let mut samples = state.metrics_samples.cpu_samples.locked();
        if let Some(&(pidle, ptotal)) = samples.get(&session_id) {
            let dt = total.saturating_sub(ptotal);
            let di = idle.saturating_sub(pidle);
            if dt > 0 {
                m.cpu_pct = Some(((dt - di) as f64 / dt as f64 * 100.0).clamp(0.0, 100.0));
            }
        }
        samples.insert(session_id.clone(), (idle, total));
    }

    // The busiest processes now (v1.33): the growth of each one's ticks since the
    // last poll — on Linux `ps`'s `%cpu` is a lifetime average, and a service
    // busy for a minute after weeks idle never made the top. The first poll of a
    // session has no reading and names nobody, rather than a zero.
    if line_of(&raw, "topticks=").is_some() {
        let clk = line_of(&raw, "clk=")
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|c| *c > 0.0);
        let (ticks, names) = parse_topticks(&raw);
        let cpu = proc_cpu_map(&state.metrics_samples.top_samples, &session_id, ticks, clk);
        m.top_proc = local::top_procs_label(&named_cpu(&cpu, &names), 3);
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

/// Every process (v1.33), read once for the whole detail probe: `ps` gives who,
/// state, age, threads, size and name (at most `PROC_CAP` rows), `/proc/<pid>/stat`
/// the CPU ticks each has used and when it started. The current CPU% is the
/// growth of those ticks between two polls, in Rust — `ps`'s own `%cpu` on Linux
/// is the process's lifetime average, so a long-running service showed what it
/// averaged over weeks and a process busy now could miss the top six. Hosts with
/// no `/proc` (BSD, macOS) fall back to their `ps`, whose `%cpu` there is a recent
/// decaying average (`procfmt=bsd`). The Linux form runs only where `/proc` is:
/// macOS `ps` skips the keywords it does not know and prints the rest, shifted.
macro_rules! procs_snippet {
    () => {
        r#"
printf 'clk=%s\n' "$(getconf CLK_TCK 2>/dev/null)"
printf 'proctotal=%s\n' "$(ls -d /proc/[0-9]* 2>/dev/null | wc -l | tr -d ' ')"
printf 'procticks=%s\n' "$(awk '{p=$1; sub(/^.*\) /,""); printf "%s %s %s %s;",p,$12,$13,$20}' /proc/[0-9]*/stat 2>/dev/null)"
pl=""
[ -r /proc/self/stat ] && pl=$(ps -eo pid=,ppid=,user:32=,stat=,etimes=,nlwp=,rss=,pmem=,comm= 2>/dev/null | head -3000)
if [ -n "$pl" ]; then
  printf 'procfmt=linux\n'
  printf 'proclist=%s\n' "$(printf '%s\n' "$pl" | awk 'NF>=9{c=$9; for(i=10;i<=NF;i++) c=c " " $i; printf "%s|%s|%s|%s|%s|%s|%s|%s|%s\036",$1,$2,$3,$4,$5,$6,$7,$8,c}')"
else
  pl=$(ps -axo pid=,ppid=,user=,stat=,pcpu=,pmem=,rss=,comm= 2>/dev/null | head -3000)
  [ -n "$pl" ] && printf 'procfmt=bsd\n'
  printf 'proclist=%s\n' "$(printf '%s\n' "$pl" | awk 'NF>=8{c=$8; for(i=9;i<=NF;i++) c=c " " $i; printf "%s|%s|%s|%s|%s|%s|%s|%s\036",$1,$2,$3,$4,$5,$6,$7,c}')"
fi
"#
    };
}

/// Richer, heavier probe than the status bar's `METRICS_SCRIPT`. Run only when
/// the monitoring overlay is open. Lines are `key=value`; multi-record values
/// (partitions, TCP states) pack records separated by `;`/spaces.
const DETAIL_SCRIPT: &str = concat!(
    "\
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
printf 'failed=%s\\n' \"$(command -v systemctl >/dev/null 2>&1 && systemctl --failed --no-legend 2>/dev/null | wc -l | tr -d ' ')\"; \
printf 'listen=%s\\n' \"$(command -v ss >/dev/null 2>&1 && ss -tlnH 2>/dev/null | wc -l | tr -d ' ')\"; \
printf 'conntrack=%s %s\\n' \"$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null)\" \"$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null)\"; \
printf 'timesync=%s\\n' \"$(command -v timedatectl >/dev/null 2>&1 && timedatectl show -p NTPSynchronized --value 2>/dev/null)\"; \
printf 'netdev=%s\\n' \"$(awk 'NR>2{sub(/:/,\"\");if($1!=\"lo\")printf \"%s,%s,%s,%s,%s,%s,%s;\",$1,$2,$4,$5,$10,$12,$13}' /proc/net/dev 2>/dev/null)\"; \
printf 'diskdev=%s\\n' \"$(awk '$3!~/^(loop|ram|dm-|sr)/ && ($6>0||$10>0){printf \"%s,%s,%s,%s,%s,%s,%s,%s;\",$3,$6,$10,$4,$8,$7,$11,$13}' /proc/diskstats 2>/dev/null)\"; \
printf 'sessions=%s\\n' \"$(who 2>/dev/null | awk '{f=\"\";if($NF ~ /^\\(.*\\)$/){f=$NF;gsub(/[()]/,\"\",f)}printf \"%s,%s,%s %s,%s;\",$1,$2,$3,$4,f}')\"; \
printf 'ctxintr=%s\\n' \"$(awk '/^ctxt /{c=$2}/^intr /{i=$2}END{printf \"%d %d\",c,i}' /proc/stat 2>/dev/null)\"; \
printf 'procs=%s\\n' \"$(awk '/^procs_running/{r=$2}/^procs_blocked/{b=$2}END{printf \"%d %d\",r,b}' /proc/stat 2>/dev/null)\"; \
printf 'failednames=%s\\n' \"$(command -v systemctl >/dev/null 2>&1 && systemctl --failed --plain --no-legend --no-pager 2>/dev/null | awk '{print $1}' | head -20 | tr '\\n' ' ')\"; \
printf 'vmstat=%s\\n' \"$(awk '/^pswpin /{i=$2}/^pswpout /{o=$2}END{if(i!=\"\"&&o!=\"\")printf \"%s %s\",i,o}' /proc/vmstat 2>/dev/null)\"; \
printf 'pagesize=%s\\n' \"$(getconf PAGESIZE 2>/dev/null)\"; \
printf 'cpufreq=%s\\n' \"$(awk '{split(FILENAME,a,\"/\"); n=a[6]; sub(/cpu/,\"\",n); printf \"%s:%s \",n,$1}' /sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq 2>/dev/null)\"; \
printf 'throttle=%s\\n' \"$(cat /sys/devices/system/cpu/cpu[0-9]*/thermal_throttle/core_throttle_count 2>/dev/null | awk '{s+=$1}END{if(NR)print s}')\"; \
printf 'listenlist=%s\\n' \"$(command -v ss >/dev/null 2>&1 && ss -tulnpH 2>/dev/null | head -200 | awk '{printf \"%s|%s|%s;\",$1,$5,$7}')\";\n",
    procs_snippet!()
);

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
    /// Share of wall time the device had I/O in flight, 0–100; None on the first poll.
    util_pct: Option<f64>,
    /// Average time per completed read or write, ms; None when nothing completed.
    await_ms: Option<f64>,
}

/// Cumulative `/proc/diskstats` counters behind a device's utilization and latency:
/// completed reads and writes, the milliseconds spent on each, and the
/// milliseconds the device was busy at all.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct DiskTicks {
    reads: u64,
    writes: u64,
    read_ms: u64,
    write_ms: u64,
    busy_ms: u64,
}

/// One process of the full list (v1.33): who runs it, its state, age, threads,
/// size and how busy it is now. `cpu` is % of one core over the last poll — None
/// on the first poll, or where the host gives no reading.
#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcRow {
    pid: u32,
    ppid: Option<u32>,
    user: String,
    /// A [`ProcessDetail::state`] key.
    state: String,
    elapsed_secs: Option<u64>,
    threads: Option<u64>,
    /// Resident memory, bytes.
    rss: Option<u64>,
    /// Resident memory as % of RAM.
    mem: f64,
    cpu: Option<f64>,
    comm: String,
}

/// The most processes a listing carries; the rest are counted (`process_total`).
const PROC_CAP: usize = 3000;

/// A listening TCP/UDP socket from `ss -tulnp`: protocol, bound address and port,
/// and — when the session may see it (its own processes, or root) — the owner.
#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListenSocket {
    proto: String,
    addr: String,
    port: u16,
    process: Option<String>,
    pid: Option<u32>,
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
    /// Names of failed systemd units (at most 20); empty when none or unknown.
    failed_unit_names: Vec<String>,
    /// Swap traffic in bytes/s paged in and out (`/proc/vmstat` deltas × page
    /// size); None on the first poll or when the host does not report it.
    swap_in_rate: Option<u64>,
    swap_out_rate: Option<u64>,
    /// Current frequency of each logical CPU in MHz, by CPU number; empty where
    /// cpufreq is not exposed (common on virtual machines).
    cpu_freq_mhz: Vec<f64>,
    /// Thermal-throttling events since boot, summed over cores; None when the
    /// kernel does not expose the counter.
    throttle_count: Option<u64>,
    /// Listening TCP/UDP sockets (at most 200).
    listen_sockets: Vec<ListenSocket>,
    /// Every process (at most `PROC_CAP`) — sent only when the page asks for it
    /// (the Processes section is on screen); empty otherwise.
    processes: Vec<ProcRow>,
    /// How many processes the host has; may exceed `processes.len()`.
    process_total: Option<u64>,
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

/// Per-device byte rates: for each `(name, a, b)` cumulative counter, return the
/// per-second delta against this session's previous sample (updating it). Devices
/// with no prior sample (first poll) are omitted from the result.
fn dev_rate_map(
    store: &DevSampleStore,
    session_id: &str,
    cur: &[(String, u64, u64)],
) -> HashMap<String, (u64, u64)> {
    let now = Instant::now();
    let mut guard = store.locked();
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
            if f.len() != 3 && f.len() != 8 {
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

/// Parse `procticks=pid utime stime start;…` into each process's CPU ticks used
/// (user + system) and start time.
fn parse_procticks(raw: &str) -> HashMap<u32, (u64, u64)> {
    line_of(raw, "procticks=")
        .unwrap_or("")
        .split(';')
        .filter_map(|rec| {
            let f: Vec<u64> = rec
                .split_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            (f.len() == 4).then(|| (f[0] as u32, (f[1] + f[2], f[3])))
        })
        .collect()
}

/// Parse the status bar's every-process reading (v1.33), `topticks=pid utime
/// stime start comm\u{1e}…`: each process's ticks used (user + system) and start
/// time, and its name — last in the record, so a name with spaces stays whole.
fn parse_topticks(raw: &str) -> (HashMap<u32, (u64, u64)>, HashMap<u32, String>) {
    let mut ticks = HashMap::new();
    let mut names = HashMap::new();
    for rec in line_of(raw, "topticks=").unwrap_or("").split('\u{1e}') {
        let mut f = rec.splitn(5, ' ');
        let (Some(pid), Some(user), Some(system), Some(start), Some(comm)) =
            (f.next(), f.next(), f.next(), f.next(), f.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(user), Ok(system), Ok(start)) = (
            pid.trim().parse::<u32>(),
            user.parse::<u64>(),
            system.parse::<u64>(),
            start.parse::<u64>(),
        ) else {
            continue;
        };
        if comm.is_empty() {
            continue;
        }
        ticks.insert(pid, (user + system, start));
        names.insert(pid, comm.to_string());
    }
    (ticks, names)
}

/// The processes with a CPU reading, by name, for the status bar's label.
fn named_cpu(cpu: &HashMap<u32, f64>, names: &HashMap<u32, String>) -> Vec<(String, f64)> {
    cpu.iter()
        .filter_map(|(pid, c)| Some((names.get(pid)?.clone(), *c)))
        .collect()
}

/// Each process's CPU, % of one core, over the `secs` between two samples of
/// ticks at `clk` per second. A pid whose start time changed is another process:
/// it has no previous reading.
fn proc_cpu(
    prev: &HashMap<u32, (u64, u64)>,
    cur: &HashMap<u32, (u64, u64)>,
    secs: f64,
    clk: f64,
) -> HashMap<u32, f64> {
    if secs <= 0.0 || clk <= 0.0 || secs.is_nan() {
        return HashMap::new();
    }
    cur.iter()
        .filter_map(|(pid, &(ticks, start))| {
            let &(was, was_start) = prev.get(pid)?;
            (was_start == start && ticks >= was)
                .then(|| (*pid, (ticks - was) as f64 / clk / secs * 100.0))
        })
        .collect()
}

/// Current CPU% per process against this session's previous ticks (updating them).
fn proc_cpu_map(
    store: &ProcTickStore,
    session_id: &str,
    cur: HashMap<u32, (u64, u64)>,
    clk: Option<f64>,
) -> HashMap<u32, f64> {
    let now = Instant::now();
    let mut guard = store.locked();
    let out = match (guard.get(session_id), clk) {
        (Some((prev, at)), Some(clk)) => {
            proc_cpu(prev, &cur, now.duration_since(*at).as_secs_f64(), clk)
        }
        _ => HashMap::new(),
    };
    guard.insert(session_id.to_string(), (cur, now));
    out
}

/// Parse `proclist=` rows (`\u{1e}`-separated) of either `ps` form. Linux:
/// `pid|ppid|user|stat|etimes|nlwp|rss|pmem|comm`; BSD (`procfmt=bsd`):
/// `pid|ppid|user|stat|pcpu|pmem|rss|comm`, whose `%cpu` is taken as the reading.
fn parse_proclist(raw: &str) -> Vec<ProcRow> {
    let bsd = line_of(raw, "procfmt=").map(str::trim) == Some("bsd");
    line_of(raw, "proclist=")
        .unwrap_or("")
        .split('\u{1e}')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').map(str::trim).collect();
            let n = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok());
            let x = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok());
            let row = |pid: u32| ProcRow {
                pid,
                ppid: n(1).map(|v| v as u32),
                user: f[2].to_string(),
                state: ps_state(f[3]).to_string(),
                ..Default::default()
            };
            if bsd {
                if f.len() != 8 {
                    return None;
                }
                Some(ProcRow {
                    cpu: x(4),
                    mem: x(5).unwrap_or(0.0),
                    rss: n(6).map(|kib| kib * 1024),
                    comm: f[7].to_string(),
                    ..row(f[0].parse().ok()?)
                })
            } else {
                if f.len() != 9 {
                    return None;
                }
                Some(ProcRow {
                    elapsed_secs: n(4),
                    threads: n(5),
                    rss: n(6).map(|kib| kib * 1024),
                    mem: x(7).unwrap_or(0.0),
                    comm: f[8].to_string(),
                    ..row(f[0].parse().ok()?)
                })
            }
        })
        .take(PROC_CAP)
        .collect()
}

/// The six busiest by CPU now (only processes with a reading) and by memory.
fn top_of(rows: &[ProcRow]) -> (Vec<Proc>, Vec<Proc>) {
    let as_proc = |r: &ProcRow| Proc {
        pid: r.pid,
        user: r.user.clone(),
        cpu: r.cpu.unwrap_or(0.0),
        mem: r.mem,
        comm: r.comm.clone(),
    };
    let mut by_cpu: Vec<&ProcRow> = rows.iter().filter(|r| r.cpu.is_some()).collect();
    by_cpu.sort_by(|a, b| {
        b.cpu
            .unwrap_or(0.0)
            .total_cmp(&a.cpu.unwrap_or(0.0))
            .then(a.pid.cmp(&b.pid))
    });
    let mut by_mem: Vec<&ProcRow> = rows.iter().collect();
    by_mem.sort_by(|a, b| b.mem.total_cmp(&a.mem).then(a.pid.cmp(&b.pid)));
    (
        by_cpu.into_iter().take(6).map(as_proc).collect(),
        by_mem.into_iter().take(6).map(as_proc).collect(),
    )
}

/// The value of the first `prefix…` line of a probe's output.
fn line_of<'a>(raw: &'a str, prefix: &str) -> Option<&'a str> {
    raw.lines().find_map(|l| l.strip_prefix(prefix))
}

/// Parse the operation/time counters of the `diskdev=` records (fields 4–8 of
/// each; a 3-field record from an older probe has none).
fn parse_diskticks(raw: &str) -> Vec<(String, DiskTicks)> {
    line_of(raw, "diskdev=")
        .unwrap_or("")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split(',').collect();
            if f.len() != 8 {
                return None;
            }
            let n = |i: usize| f[i].parse::<u64>().ok();
            Some((
                f[0].to_string(),
                DiskTicks {
                    reads: n(3)?,
                    writes: n(4)?,
                    read_ms: n(5)?,
                    write_ms: n(6)?,
                    busy_ms: n(7)?,
                },
            ))
        })
        .collect()
}

/// A device's utilization (% of the `secs` between two samples it had I/O in
/// flight) and average latency (ms per completed read or write). With no request
/// completed there is no latency to report — `None`, not a zero.
fn disk_latency(prev: &DiskTicks, cur: &DiskTicks, secs: f64) -> (Option<f64>, Option<f64>) {
    if secs <= 0.0 || secs.is_nan() {
        return (None, None);
    }
    let busy = cur.busy_ms.saturating_sub(prev.busy_ms) as f64;
    let util = (busy / (secs * 1000.0) * 100.0).clamp(0.0, 100.0);
    let ios = cur.reads.saturating_sub(prev.reads) + cur.writes.saturating_sub(prev.writes);
    let waited =
        cur.read_ms.saturating_sub(prev.read_ms) + cur.write_ms.saturating_sub(prev.write_ms);
    let await_ms = (ios > 0).then(|| waited as f64 / ios as f64);
    (Some(util), await_ms)
}

/// Utilization and latency per device against this session's previous counters
/// (updating them). Devices with no prior sample (first poll) are omitted.
fn disk_tick_map(
    store: &DiskTickStore,
    session_id: &str,
    cur: &[(String, DiskTicks)],
) -> HashMap<String, (Option<f64>, Option<f64>)> {
    let now = Instant::now();
    let mut guard = store.locked();
    let prevs = guard.entry(session_id.to_string()).or_default();
    let mut out = HashMap::new();
    let mut next = HashMap::new();
    for (name, ticks) in cur {
        if let Some((prev, at)) = prevs.get(name) {
            let secs = now.duration_since(*at).as_secs_f64();
            out.insert(name.clone(), disk_latency(prev, ticks, secs));
        }
        next.insert(name.clone(), (*ticks, now));
    }
    *prevs = next;
    out
}

/// Parse `failednames=unit unit …` into the failed units' names.
fn parse_failed_names(raw: &str) -> Vec<String> {
    line_of(raw, "failednames=")
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

/// Parse `cpufreq=N:kHz …` into MHz per logical CPU, ordered by CPU number (the
/// shell glob lists `cpu10` before `cpu2`).
fn parse_cpufreq(raw: &str) -> Vec<f64> {
    let mut cpus: Vec<(u32, f64)> = line_of(raw, "cpufreq=")
        .unwrap_or("")
        .split_whitespace()
        .filter_map(|tok| {
            let (n, khz) = tok.split_once(':')?;
            Some((n.parse().ok()?, khz.parse::<f64>().ok()? / 1000.0))
        })
        .collect();
    cpus.sort_by_key(|(n, _)| *n);
    cpus.into_iter().map(|(_, mhz)| mhz).collect()
}

/// The first owner in an `ss -p` process column — `users:(("sshd",pid=812,fd=3),…)`
/// — as a name and pid; both None when the session may not see it.
fn socket_owner(users: &str) -> (Option<String>, Option<u32>) {
    let Some((_, rest)) = users.split_once("((\"") else {
        return (None, None);
    };
    let name = rest
        .split('"')
        .next()
        .filter(|n| !n.is_empty())
        .map(str::to_string);
    let pid = rest
        .split_once("pid=")
        .and_then(|(_, r)| r.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|p| p.parse().ok());
    (name, pid)
}

/// Parse `listenlist=proto|addr:port|users:((…));…` into listening sockets.
fn parse_listen(raw: &str) -> Vec<ListenSocket> {
    line_of(raw, "listenlist=")
        .unwrap_or("")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let mut f = rec.split('|');
            let proto = f.next()?.trim();
            let (addr, port) = f.next()?.trim().rsplit_once(':')?;
            let (process, pid) = socket_owner(f.next().unwrap_or(""));
            Some(ListenSocket {
                proto: proto.to_string(),
                addr: addr.trim_matches(['[', ']']).to_string(),
                port: port.parse().ok()?,
                process,
                pid,
            })
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
            // A distorted MemAvailable (> MemTotal, see `mem_used`) is not shown
            // as-is: procps-ng falls back to MemFree there, and so does "Available"
            // here — otherwise the overlay reads "61 GiB available of 7.3 GiB".
            d.mem_available = Some(if n[2] > n[0] { n[1] } else { n[2] });
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
    d.failed_unit_names = parse_failed_names(raw);
    d.cpu_freq_mhz = parse_cpufreq(raw);
    d.throttle_count = line_of(raw, "throttle=").and_then(|s| s.trim().parse().ok());
    d.listen_sockets = parse_listen(raw);
    d
}

/// Probe the active session for detailed metrics (monitoring overlay).
#[tauri::command]
pub async fn fetch_metrics_detail(
    state: State<'_, AppState>,
    session_id: String,
    processes: Option<bool>,
) -> AppResult<MetricsDetail> {
    let with_processes = processes.unwrap_or(false);
    let session = match state.sessions.lock().await.get(&session_id).cloned() {
        Some(s) => s,
        None if is_local_session(&state, &session_id) => {
            return Ok(local::collect_detail(with_processes).await)
        }
        None => return Err(AppError::NoSession),
    };
    let raw = session.run_command(DETAIL_SCRIPT).await?;
    let mut d = parse_detail(&raw);

    // Per-core CPU% needs two samples (per-core jiffies stored per session).
    let cur = parse_percpu(&raw);
    if !cur.is_empty() {
        let mut samples = state.metrics_samples.core_samples.locked();
        if let Some(prev) = samples.get(&session_id) {
            d.per_cpu = percpu_delta(prev, &cur);
        }
        samples.insert(session_id.clone(), cur);
    }

    // CPU time breakdown (user/system/iowait/steal/idle) from two jiffy samples.
    if let Some(cur) = parse_cpu_jiffies(&raw) {
        let mut samples = state.metrics_samples.cpu_stat_samples.locked();
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
                    ..Default::default()
                })
            })
            .collect();
    }

    // Device utilization and request latency from operation/time counter deltas.
    let ticks = parse_diskticks(&raw);
    let latency = disk_tick_map(&state.metrics_samples.diskstat_samples, &session_id, &ticks);
    for dev in &mut d.disk_devs {
        if let Some(&(util, wait)) = latency.get(&dev.name) {
            dev.util_pct = util;
            dev.await_ms = wait;
        }
    }

    // Context-switch / interrupt rates (delta of cumulative counters).
    if let Some(ci) = parse_pair(&raw, "ctxintr") {
        (d.ctxt_rate, d.intr_rate) =
            rate_from(&state.metrics_samples.ctxintr_samples, &session_id, ci);
    }

    // Swap traffic: pages in/out per second, times the host's page size.
    if let Some(vm) = parse_pair(&raw, "vmstat") {
        let page = line_of(&raw, "pagesize=").and_then(|s| s.trim().parse::<u64>().ok());
        let (pin, pout) = rate_from(&state.metrics_samples.vmstat_samples, &session_id, vm);
        d.swap_in_rate = pin.zip(page).map(|(r, p)| r * p);
        d.swap_out_rate = pout.zip(page).map(|(r, p)| r * p);
    }

    // Every process, with its CPU now from the growth of its ticks (not ps's
    // lifetime average); the six busiest come from the same reading.
    let mut rows = parse_proclist(&raw);
    if line_of(&raw, "procfmt=").map(str::trim) == Some("linux") {
        let clk = line_of(&raw, "clk=")
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|c| *c > 0.0);
        let cpu = proc_cpu_map(
            &state.metrics_samples.proc_samples,
            &session_id,
            parse_procticks(&raw),
            clk,
        );
        for r in &mut rows {
            r.cpu = cpu.get(&r.pid).copied();
        }
    }
    d.process_total = line_of(&raw, "proctotal=")
        .and_then(|v| v.trim().parse().ok())
        .filter(|n| *n > 0)
        .or((!rows.is_empty()).then_some(rows.len() as u64));
    (d.top_procs, d.top_mem_procs) = top_of(&rows);
    if with_processes {
        d.processes = rows;
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

/// NVIDIA GPUs — utilization, memory, temperature, power, clocks — and the
/// processes using them. Shared by the once-per-open extras and the live poll.
macro_rules! gpu_snippet {
    () => {
        r#"
gpu=""; gpuapps=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu=$(nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,pci.bus_id --format=csv,noheader,nounits 2>/dev/null | awk -F', *' '{printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s;",$1,$2,$3,$4,$5,$6,$7,$8,$9,$10}')
  gpuapps=$(nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null | awk -F', *' '{printf "%s|%s|%s|%s;",$1,$2,$3,$4}')
fi
printf 'gpu=%s\n' "$gpu"
printf 'gpuapps=%s\n' "$gpuapps"
"#
    };
}

/// Running Docker containers' live stats, plus each one's configured memory and
/// CPU limits (`HostConfig`: 0 = none) — a share is only drawn against a limit
/// that was set. Shared by the extras and the live poll.
macro_rules! docker_snippet {
    () => {
        r#"
docker=""; dockerlim=""
if command -v docker >/dev/null 2>&1; then
  docker=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null | awk '{gsub(/%/,"");printf "%s;",$0}')
  dockerlim=$(docker ps -q 2>/dev/null | xargs -r docker inspect --format '{{.Name}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}' 2>/dev/null | awk '{printf "%s;",$0}')
fi
printf 'docker=%s\n' "$docker"
printf 'dockerlim=%s\n' "$dockerlim"
"#
    };
}

/// Optional "extras" probed once when the monitoring overlay opens: NVIDIA GPUs,
/// Docker containers, disk SMART health, OOM kills and recent logins. Heavy/optional
/// and best-effort (each guarded by `command -v`; SMART needs root, so it populates
/// for root sessions and is empty otherwise) — never part of the per-poll detail
/// probe. The kernel log is read from the journal or `dmesg`; when neither can be
/// read, `oomsrc` stays empty and the kill count is unknown rather than zero.
const EXTRAS_SCRIPT: &str = concat!(
    gpu_snippet!(),
    docker_snippet!(),
    r#"
k=""; oomsrc=""
if command -v journalctl >/dev/null 2>&1; then k=$(journalctl -k -b -o short-iso --no-pager 2>/dev/null); [ -n "$k" ] && oomsrc=journal; fi
if [ -z "$k" ]; then k=$(dmesg 2>/dev/null); [ -n "$k" ] && oomsrc=dmesg; fi
printf 'oomsrc=%s\n' "$oomsrc"
printf 'oom=%s\n' "$(printf '%s\n' "$k" | grep -ic 'out of memory')"
printf 'oomkilled=%s\n' "$(printf '%s\n' "$k" | grep -i 'killed process' | tail -10 | tr '\n' '\036')"
smart=""
for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
  o=$(smartctl -H -A /dev/$d 2>/dev/null)
  [ -z "$o" ] && continue
  h=$(printf '%s\n' "$o" | awk '/overall-health/{print $NF}')
  t=$(printf '%s\n' "$o" | awk '/Temperature_Celsius/{print $10} /^Temperature:/{print $2}' | head -1)
  p=$(printf '%s\n' "$o" | awk '/Power_On_Hours/{print $10} /Power On Hours/{print $NF}' | head -1)
  w=$(printf '%s\n' "$o" | awk '/Percentage Used:/{gsub(/%/,"",$3); print "used:" $3; exit} /Wear_Leveling_Count|Media_Wearout_Indicator/{print "left:" $4; exit}')
  r=$(printf '%s\n' "$o" | awk '/Reallocated_Sector_Ct/{print $10; exit}')
  smart="$smart$d|$h|$t|$p|$w|$r;"
done
printf 'smart=%s\n' "$smart"
l=""; loginsok=""
if command -v last >/dev/null 2>&1 && l=$(last -n 10 -w -i --time-format iso 2>/dev/null); then loginsok=1; fi
printf 'loginsok=%s\n' "$loginsok"
printf 'logins=%s\n' "$(printf '%s\n' "$l" | awk 'NF>=4 && $1!="reboot" && $1!="wtmp" {printf "%s|%s|%s|%s|%s;",$1,$2,$3,$4,($0 ~ /still logged in/)?1:0}')"
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
"#
);

/// The part of the extras that changes by the second — GPUs and containers —
/// polled while the Containers or GPU section is on screen.
const LIVE_SCRIPT: &str = concat!(gpu_snippet!(), docker_snippet!());

/// A process using a GPU, from `nvidia-smi --query-compute-apps`.
#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuProc {
    pid: u32,
    name: String,
    /// GPU memory the process holds, MiB.
    mem_mib: Option<u64>,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    name: String,
    util: f64,
    /// VRAM used / total in MiB (as reported by nvidia-smi `nounits`).
    mem_used: u64,
    mem_total: u64,
    temp: f64,
    /// Power draw and the board's limit, W; None where the driver says `[N/A]`.
    power_draw: Option<f64>,
    power_limit: Option<f64>,
    /// Graphics (SM) and memory clocks, MHz.
    clock_sm: Option<f64>,
    clock_mem: Option<f64>,
    procs: Vec<GpuProc>,
    /// PCI bus id — joins `gpuapps` rows to their GPU; not sent to the page.
    #[serde(skip)]
    bus_id: String,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerStat {
    name: String,
    cpu: f64,
    /// Memory usage string, e.g. "1.2GiB / 3.8GiB".
    mem: String,
    /// Memory in use, bytes (the left half of `mem`).
    mem_used: Option<u64>,
    /// Configured memory limit, bytes; None when the container has none
    /// (`docker stats` then shows the host's memory, which is not a limit).
    mem_limit: Option<u64>,
    /// Configured CPU limit in cores (`--cpus`); None when unset.
    cpu_limit: Option<f64>,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SmartDisk {
    device: String,
    health: String,
    temp: Option<f64>,
    power_on_hours: Option<u64>,
    /// Share of the rated endurance used, %: NVMe "Percentage Used", or 100 minus
    /// an ATA SSD's normalized wear-levelling value.
    wear_pct: Option<f64>,
    /// ATA reallocated sectors (raw count); None for NVMe and unreported.
    reallocated: Option<u64>,
}

/// A process the kernel's OOM killer ended, from the kernel log of this boot.
#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OomVictim {
    pid: Option<u32>,
    name: String,
    /// When, from the journal (`short-iso`); None when read from `dmesg`.
    at: Option<String>,
    /// When, in seconds since boot, from `dmesg`; None when read from the journal.
    boot_secs: Option<f64>,
}

/// A recent login from `last` (newest first).
#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    user: String,
    tty: String,
    from: String,
    /// Login time, ISO 8601.
    at: String,
    /// Still logged in.
    active: bool,
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
    /// "Out of memory" events in this boot's kernel log; None when the log could
    /// not be read (no journal access, `dmesg` restricted) — unknown, not zero.
    oom_kills: Option<u64>,
    /// The last processes the OOM killer ended (at most 10).
    oom_victims: Vec<OomVictim>,
    /// The last logins (at most 10); None when `last` is missing or unreadable.
    logins: Option<Vec<Login>>,
    hardware: Hardware,
}

/// The live part of the extras: GPUs and containers, polled while on screen.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveExtras {
    gpus: Vec<Gpu>,
    docker: Vec<DockerStat>,
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

/// A `nvidia-smi` number; `[N/A]`, `[Not Supported]` and blanks are unknown.
fn smi_num(v: &str) -> Option<f64> {
    v.trim().parse().ok()
}

/// Parse `gpu=` records (5 fields from an older probe, 10 now) and attach the
/// `gpuapps=` processes to their GPU by PCI bus id.
fn parse_gpus(raw: &str) -> Vec<Gpu> {
    let mut gpus: Vec<Gpu> = line_of(raw, "gpu=")
        .unwrap_or("")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').map(str::trim).collect();
            if f.len() != 5 && f.len() != 10 {
                return None;
            }
            let at = |i: usize| f.get(i).copied().unwrap_or("");
            Some(Gpu {
                name: f[0].to_string(),
                util: f[1].parse().unwrap_or(0.0),
                mem_used: f[2].parse().unwrap_or(0),
                mem_total: f[3].parse().unwrap_or(0),
                temp: f[4].parse().unwrap_or(0.0),
                power_draw: smi_num(at(5)),
                power_limit: smi_num(at(6)),
                clock_sm: smi_num(at(7)),
                clock_mem: smi_num(at(8)),
                bus_id: at(9).to_string(),
                procs: Vec::new(),
            })
        })
        .collect();
    for rec in line_of(raw, "gpuapps=")
        .unwrap_or("")
        .split(';')
        .filter(|r| !r.is_empty())
    {
        let f: Vec<&str> = rec.split('|').map(str::trim).collect();
        if f.len() != 4 {
            continue;
        }
        let Ok(pid) = f[1].parse() else { continue };
        let proc_ = GpuProc {
            pid,
            name: f[2].to_string(),
            mem_mib: f[3].parse().ok(),
        };
        if let Some(g) = gpus
            .iter_mut()
            .find(|g| !g.bus_id.is_empty() && g.bus_id == f[0])
        {
            g.procs.push(proc_);
        }
    }
    gpus
}

/// A size as `docker stats` prints it — "512MiB", "1.94GiB", "12.5kB", "0B" — in bytes.
fn parse_size(v: &str) -> Option<u64> {
    let v = v.trim();
    let split = v.find(|c: char| c.is_ascii_alphabetic())?;
    let (num, unit) = v.split_at(split);
    let n: f64 = num.trim().parse().ok()?;
    let mult = match unit {
        "B" => 1.0,
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        "KiB" => 1024.0,
        "MiB" => 1024f64.powi(2),
        "GiB" => 1024f64.powi(3),
        "TiB" => 1024f64.powi(4),
        _ => return None,
    };
    Some((n * mult) as u64)
}

/// Parse `docker=name|cpu|used / limit;…` and join each container's configured
/// limits from `dockerlim=/name|memoryBytes|nanoCpus;…` (0 = none set).
fn parse_docker(raw: &str) -> Vec<DockerStat> {
    let limits: HashMap<String, (u64, u64)> = line_of(raw, "dockerlim=")
        .unwrap_or("")
        .split(';')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').map(str::trim).collect();
            if f.len() != 3 {
                return None;
            }
            let name = f[0].trim_start_matches('/').to_string();
            Some((name, (f[1].parse().ok()?, f[2].parse().ok()?)))
        })
        .collect();
    line_of(raw, "docker=")
        .unwrap_or("")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 3 {
                return None;
            }
            let name = f[0].trim().to_string();
            let (mem_limit, cpu_limit) = match limits.get(&name) {
                Some(&(mem, nano)) => (
                    (mem > 0).then_some(mem),
                    (nano > 0).then(|| nano as f64 / 1e9),
                ),
                None => (None, None),
            };
            Some(DockerStat {
                cpu: f[1].trim().parse().unwrap_or(0.0),
                mem: f[2].trim().to_string(),
                mem_used: f[2].split('/').next().and_then(parse_size),
                mem_limit,
                cpu_limit,
                name,
            })
        })
        .collect()
}

/// Parse `smart=dev|health|temp|hours|wear|realloc;…` (4 fields from an older probe).
fn parse_smart(raw: &str) -> Vec<SmartDisk> {
    line_of(raw, "smart=")
        .unwrap_or("")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').map(str::trim).collect();
            if (f.len() != 4 && f.len() != 6) || f[0].is_empty() {
                return None;
            }
            let at = |i: usize| f.get(i).copied().unwrap_or("");
            Some(SmartDisk {
                device: f[0].to_string(),
                health: f[1].to_string(),
                temp: f[2].parse().ok(),
                power_on_hours: f[3].parse().ok(),
                wear_pct: wear_used(at(4)),
                reallocated: at(5).parse().ok(),
            })
        })
        .collect()
}

/// `used:N` (NVMe "Percentage Used") as is; `left:N` (an ATA SSD's normalized
/// wear value, 100 = new) as the share used — the subtraction happens here, not on
/// the host.
fn wear_used(v: &str) -> Option<f64> {
    let (kind, n) = v.split_once(':')?;
    let n: f64 = n.trim().parse().ok()?;
    match kind {
        "used" => Some(n.max(0.0)),
        "left" => Some((100.0 - n).clamp(0.0, 100.0)),
        _ => None,
    }
}

/// One kernel-log line about an OOM kill → the victim and when. Journal lines
/// start with an ISO time; `dmesg` lines with `[seconds since boot]`.
fn parse_oom_line(line: &str) -> Option<OomVictim> {
    let lower = line.to_ascii_lowercase();
    let i = lower.find("killed process ")?;
    let rest = &line[i + "killed process ".len()..];
    let pid = rest
        .split(|c: char| !c.is_ascii_digit())
        .next()
        .and_then(|p| p.parse().ok());
    let name = rest
        .split_once('(')
        .and_then(|(_, r)| r.split_once(')'))
        .map(|(n, _)| n.to_string())
        .unwrap_or_default();
    let head = line.trim_start();
    let (at, boot_secs) = if let Some(b) = head.strip_prefix('[') {
        (
            None,
            b.split(']').next().and_then(|v| v.trim().parse().ok()),
        )
    } else {
        let first = head.split_whitespace().next().unwrap_or("");
        let iso =
            first.len() >= 19 && first.as_bytes().get(4) == Some(&b'-') && first.contains('T');
        (iso.then(|| first.to_string()), None)
    };
    Some(OomVictim {
        pid,
        name,
        at,
        boot_secs,
    })
}

/// Parse `logins=user|tty|from|iso|active;…` (only when `loginsok=1`).
fn parse_logins(raw: &str) -> Option<Vec<Login>> {
    if line_of(raw, "loginsok=").map(str::trim) != Some("1") {
        return None;
    }
    Some(
        line_of(raw, "logins=")
            .unwrap_or("")
            .split(';')
            .filter(|r| !r.is_empty())
            .filter_map(|rec| {
                let f: Vec<&str> = rec.split('|').map(str::trim).collect();
                if f.len() != 5 || f[0].is_empty() {
                    return None;
                }
                Some(Login {
                    user: f[0].to_string(),
                    tty: f[1].to_string(),
                    from: f[2].to_string(),
                    at: f[3].to_string(),
                    active: f[4] == "1",
                })
            })
            .collect(),
    )
}

fn parse_extras(raw: &str) -> Extras {
    let field = |key: &str| line_of(raw, key).unwrap_or("");
    let oom_read = !field("oomsrc=").trim().is_empty();
    let oom_kills = if oom_read {
        field("oom=").trim().parse().ok()
    } else {
        None
    };
    let oom_victims = if oom_read {
        field("oomkilled=")
            .split('\u{1e}')
            .filter_map(parse_oom_line)
            .collect()
    } else {
        Vec::new()
    };
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
        gpus: parse_gpus(raw),
        docker: parse_docker(raw),
        smart: parse_smart(raw),
        oom_kills,
        oom_victims,
        logins: parse_logins(raw),
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

/// Poll the live extras (GPUs, containers) — only while their section is on screen.
#[tauri::command]
pub async fn fetch_live_extras(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<LiveExtras> {
    let session = match state.sessions.lock().await.get(&session_id).cloned() {
        Some(s) => s,
        // Local tabs skip the server-shaped GPU/Docker probes, as `fetch_extras` does.
        None if is_local_session(&state, &session_id) => return Ok(LiveExtras::default()),
        None => return Err(AppError::NoSession),
    };
    let raw = session.run_command(LIVE_SCRIPT).await?;
    Ok(LiveExtras {
        gpus: parse_gpus(&raw),
        docker: parse_docker(&raw),
    })
}

/// One process, read on a click — never polled: its command line, state, age,
/// threads, resident memory and, where the session may read `/proc/<pid>/fd`,
/// the number of open descriptors.
#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetail {
    pid: u32,
    user: String,
    /// `running` | `sleeping` | `disk` | `stopped` | `zombie` | `idle` | `other`;
    /// empty when unknown. English keys: the page localizes them.
    state: String,
    elapsed_secs: Option<u64>,
    threads: Option<u64>,
    /// Resident memory, bytes.
    rss: Option<u64>,
    cmdline: String,
    fds: Option<u64>,
}

/// The probe for one process. `pid` is a number, so nothing else reaches the shell.
fn process_script(pid: u32) -> String {
    format!(
        concat!(
            "p={pid}; ",
            "[ -d /proc/$p ] && printf 'alive=1\\n'; ",
            "printf 'ps=%s\\n' \"$(ps -o user=,stat=,etimes=,nlwp=,rss= -p $p 2>/dev/null)\"; ",
            "printf 'args=%s\\n' \"$(ps -o args= -p $p 2>/dev/null)\"; ",
            "[ -r /proc/$p/fd ] && printf 'fds=%s\\n' \"$(ls /proc/$p/fd 2>/dev/null | wc -l | tr -d ' ')\"; ",
            "true"
        ),
        pid = pid
    )
}

/// A `ps` STAT code (`Ssl`, `R+`, `D`) as one of the [`ProcessDetail::state`] keys.
fn ps_state(stat: &str) -> &'static str {
    match stat.chars().next() {
        Some('R') => "running",
        Some('S') => "sleeping",
        Some('D') => "disk",
        Some('T') | Some('t') => "stopped",
        Some('Z') => "zombie",
        Some('I') => "idle",
        Some(_) => "other",
        None => "",
    }
}

/// Parse the process probe; None when the process is gone (neither `/proc/<pid>`
/// nor a `ps` row).
fn parse_process(raw: &str, pid: u32) -> Option<ProcessDetail> {
    let ps = line_of(raw, "ps=").unwrap_or("").trim();
    let alive = line_of(raw, "alive=").is_some();
    if ps.is_empty() && !alive {
        return None;
    }
    let f: Vec<&str> = ps.split_whitespace().collect();
    let num = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok());
    Some(ProcessDetail {
        pid,
        user: f.first().map(|v| v.to_string()).unwrap_or_default(),
        state: f.get(1).map(|v| ps_state(v)).unwrap_or("").to_string(),
        elapsed_secs: num(2),
        threads: num(3),
        rss: num(4).map(|kib| kib * 1024),
        cmdline: line_of(raw, "args=").unwrap_or("").trim().to_string(),
        fds: line_of(raw, "fds=").and_then(|v| v.trim().parse().ok()),
    })
}

/// Read one process's details for the Processes section (on a click).
#[tauri::command]
pub async fn fetch_process_detail(
    state: State<'_, AppState>,
    session_id: String,
    pid: u32,
) -> AppResult<Option<ProcessDetail>> {
    let session = match state.sessions.lock().await.get(&session_id).cloned() {
        Some(s) => s,
        None if is_local_session(&state, &session_id) => {
            return Ok(local::collect_process(pid).await)
        }
        None => return Err(AppError::NoSession),
    };
    let raw = session.run_command(&process_script(pid)).await?;
    Ok(parse_process(&raw, pid))
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
                   mem=MemTotal:4096 MemFree:512 MemAvailable:3072 Buffers:64 Cached:1024\n\
                   disk=2097152 10485760\n\
                   cpustat=100 0 50 850 0 0 0\n\
                   ncpu=8";
        let m = parse_metrics(raw);
        assert_eq!(m.cpu_count, Some(8));
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

    // Real `free -b` output (header + Mem: row, as the probe ships it), captured
    // from each binary against the same substituted /proc/meminfo: 15.3 GiB
    // total, 3.2 free, 7.6 available, 867 MiB shared, 5.6 GiB buff/cache — the
    // OL 8 host the discrepancy was reported on.
    const FREE_OL8: &str =
        "              total        used        free      shared  buff/cache   available|\
        Mem:    16428249088  6978902016  3435973632   909115392  6013373440  8160437248|";
    const FREE_OL9: &str =
        "               total        used        free      shared  buff/cache   available|\
        Mem:     16428249088  8267811840  3435973632   909115392  6013373440  8160437248|";
    /// The same /proc/meminfo, as the `mem=` probe reports it.
    const MEM_OL: &str = "MemTotal:16043212 MemFree:3355443 MemAvailable:7969177 \
        Buffers:4096 Cached:5163827 SReclaimable:704512";

    #[test]
    fn parse_free_reads_used_by_column_name_on_both_procps_generations() {
        // procps-ng 3.3.15 (OL 8): total - free - buff/cache.
        assert_eq!(
            parse_free(FREE_OL8),
            Some(FreeMem {
                total: 16428249088,
                used: 6978902016
            })
        );
        // procps-ng 3.3.17 (OL 9): total - available.
        assert_eq!(
            parse_free(FREE_OL9),
            Some(FreeMem {
                total: 16428249088,
                used: 8267811840
            })
        );
    }

    #[test]
    fn parse_free_rejects_layouts_it_cannot_read_unambiguously() {
        // busybox fused `total` with an underflowed `used`: 5 fields under 6 headers.
        assert_eq!(
            parse_free(
                "              total        used        free      shared  buff/cache   available|\
                 Mem:    1252918476818446744068331418624 11890544640      614400  6016773120  8160437248|"
            ),
            None
        );
        // procps 3.2 (CentOS 6): legacy layout, whose Mem: "used" counts page cache.
        assert_eq!(
            parse_free(
                "             total       used       free     shared    buffers     cached|\
                 Mem:    16428249088 12992275456 3435973632  909115392    4194304 5287758848|"
            ),
            None
        );
        // `free` missing on the host: the probe ships nothing.
        assert_eq!(parse_free(""), None);
        // More used than total is not a reading.
        assert_eq!(
            parse_free("total used free shared buff/cache available|Mem: 100 200 0 0 0 0|"),
            None
        );
    }

    #[test]
    fn mem_used_is_what_the_hosts_free_says() {
        // OL 8: the status bar showed 7.7 GiB (total - available) while `free -h`
        // said 6.5 GiB. Now it says what `free` says, on either generation.
        let m = parse_metrics(&format!("mem={MEM_OL}\nfree={FREE_OL8}"));
        assert_eq!(m.mem_used, Some(6978902016));
        assert_eq!(m.mem_total, Some(16428249088));
        let m = parse_metrics(&format!("mem={MEM_OL}\nfree={FREE_OL9}"));
        assert_eq!(m.mem_used, Some(8267811840));
    }

    #[test]
    fn a_free_describing_other_memory_is_ignored() {
        // busybox reads sysinfo(): under lxcfs that is the host, while
        // /proc/meminfo is the container. Totals disagree -> compute ourselves.
        let m = parse_metrics(&format!(
            "mem={MEM_OL}\nfree=total used free shared buff/cache available|Mem: 99999999999 1 0 0 0 0|"
        ));
        assert_eq!(m.mem_used, Some((16043212 - 7969177) * 1024));
        assert_eq!(m.mem_total, Some(16428249088));
    }

    #[test]
    fn mem_used_without_free_is_total_minus_available() {
        let m = parse_metrics(&format!("mem={MEM_OL}"));
        assert_eq!(m.mem_used, Some((16043212 - 7969177) * 1024));
    }

    #[test]
    fn mem_used_without_free_on_a_distorted_mem_available_is_total_minus_free() {
        // Real OL 9.8 VM: MemAvailable 61.2 GiB on a 7.3 GiB machine, swapping.
        // procps-ng >= 3.3.17 (OL 9's `free`) then treats available as free and
        // prints total - free = 7.11 GiB; the fallback agrees. v1.0.15-v1.0.19
        // showed 0 here, v1.0.20 showed OL 8's figure (5.15 GiB).
        let m = parse_metrics(
            "mem=MemTotal:7666684 MemFree:212480 MemAvailable:64207808 \
             Buffers:4096 Cached:1843200 SReclaimable:204800",
        );
        assert_eq!(m.mem_used, Some((7666684 - 212480) * 1024));
        assert_eq!(m.mem_total, Some(7666684 * 1024));
    }

    #[test]
    fn mem_used_without_mem_available_uses_the_pre_3_14_formula() {
        // Kernels < 3.14 have no MemAvailable: total - free - buffers - cache.
        let m = parse_metrics("mem=MemTotal:8000 MemFree:1000 Buffers:500 Cached:2000");
        assert_eq!(m.mem_used, Some(4500 * 1024));
        // ...and total - free when buffers + cache are distorted too.
        let m = parse_metrics("mem=MemTotal:8000 MemFree:1000 Buffers:500 Cached:9000");
        assert_eq!(m.mem_used, Some(7000 * 1024));
    }

    #[test]
    fn mem_used_is_unknown_rather_than_invented_when_fields_are_missing() {
        // Only the total survived and no `free`: "used" is unknown, not
        // "everything" and not "nothing" — the UI shows a dash beside the total.
        let m = parse_metrics("mem=MemTotal:8000");
        assert_eq!(m.mem_used, None);
        assert_eq!(m.mem_total, Some(8000 * 1024));
        // Distorted MemAvailable with no MemFree to fall back on: still unknown.
        let m = parse_metrics("mem=MemTotal:8000 MemAvailable:90000");
        assert_eq!(m.mem_used, None);
    }

    #[test]
    fn parse_meminfo_ignores_foreign_keys_and_garbage() {
        let m = parse_meminfo("SwapCached:999 MemTotal:10 MemFree:x Cached: bogus MemAvailable:4");
        assert_eq!(
            m,
            MemInfo {
                total: Some(10 * 1024),
                available: Some(4 * 1024),
                ..MemInfo::default()
            }
        );
    }

    #[test]
    fn swap_used_is_unknown_when_free_is_distorted_or_missing() {
        // Swap has no second estimate to fall back on, so unknown beats a
        // plausible zero or a plausible "all of it".
        let m = parse_metrics("swap=1073741824 1073742848");
        assert_eq!(m.swap_used, None);
        assert_eq!(m.swap_total, Some(1073741824));
        let m = parse_metrics("swap=4096");
        assert_eq!(m.swap_used, None);
        assert_eq!(m.swap_total, Some(4096));
        let m = parse_metrics("swap=4096 1024");
        assert_eq!(m.swap_used, Some(3072));
    }

    /// Every `awk '<program>'` in a probe script.
    fn awk_programs(script: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut rest = script;
        while let Some(i) = rest.find("awk '") {
            let tail = &rest[i + "awk '".len()..];
            let end = tail.find('\'').unwrap_or(tail.len());
            out.push(&tail[..end]);
            rest = &tail[end..];
        }
        out
    }

    /// Whether an awk program subtracts one operand from another: `(t-a)`, `$4-$2`.
    /// Operands are awk fields (`$N`) or single-letter variables, which is all a
    /// probe ever uses. Hyphens inside regexes and device names (`[a-z0-9]`,
    /// `dm-`, `overall-health`) have multi-character neighbours, so they are not
    /// mistaken for arithmetic.
    fn subtracts_operands(program: &str) -> bool {
        let b = program.as_bytes();
        let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
        program.match_indices('-').any(|(i, _)| {
            let mut l = i;
            while l > 0 && b[l - 1] == b' ' {
                l -= 1;
            }
            let left = l > 0 && {
                let c = b[l - 1];
                c == b')'
                    || (c.is_ascii_digit() && {
                        let mut k = l - 1;
                        while k > 0 && b[k - 1].is_ascii_digit() {
                            k -= 1;
                        }
                        k > 0 && b[k - 1] == b'$'
                    })
                    || (c.is_ascii_alphabetic() && (l < 2 || !word(b[l - 2])))
            };
            let mut r = i + 1;
            while r < b.len() && b[r] == b' ' {
                r += 1;
            }
            let right = r < b.len() && {
                let c = b[r];
                c == b'('
                    || c == b'$'
                    || (c.is_ascii_alphabetic() && (r + 1 >= b.len() || !word(b[r + 1])))
            };
            left && right
        })
    }

    /// Guard: probe scripts report raw readings; anything derived from them is
    /// computed in Rust, where distorted input can be recognised and tested.
    ///
    /// `mem`/`swap` used to ship `(MemTotal-MemAvailable)` straight from awk. A
    /// host that reports more available than total (lxcfs, ballooning) then sent
    /// a negative field, `u64` parsing dropped it, and "used" became `None` — a
    /// dash beside a live "total", indistinguishable from a probe that never ran.
    /// The arithmetic belongs in `mem_used` / `swap_used_and_total`.
    #[test]
    fn probe_scripts_report_raw_readings_not_differences() {
        // Live violation: the exact expression this guard was written to reject.
        assert!(subtracts_operands(
            "/MemTotal/{t=$2}/MemAvailable/{a=$2}END{if(t>0)printf \"%d %d\",(t-a)*1024,t*1024}"
        ));
        assert!(subtracts_operands("{printf \"%d\",$4 - $2}"));
        // Hyphens that are not arithmetic stay quiet.
        assert!(!subtracts_operands("$3 ~ /^(sd|nvme)[a-z0-9]*$/ {r+=$6}"));
        assert!(!subtracts_operands("$3!~/^(loop|ram|dm-|sr)/{print $3}"));
        assert!(!subtracts_operands("/overall-health/{print $NF}"));

        let process = process_script(1);
        let offenders: Vec<&str> = [
            METRICS_SCRIPT,
            DETAIL_SCRIPT,
            PENDING_SCRIPT,
            EXTRAS_SCRIPT,
            LIVE_SCRIPT,
            process.as_str(),
        ]
        .iter()
        .flat_map(|s| awk_programs(s))
        .filter(|p| subtracts_operands(p))
        .collect();
        assert!(
            offenders.is_empty(),
            "probe scripts must report raw readings — a difference computed on the \
             host can go negative and is then indistinguishable from missing data. \
             Compute it in Rust (see mem_used). Offenders: {offenders:?}"
        );
    }

    #[test]
    fn parse_metrics_ignores_garbage_and_blanks() {
        let m = parse_metrics("garbage line\n\nload=notanumber\nmem=\n=oops\nunknown=1");
        assert_eq!(m.load1, None);
        assert_eq!(m.mem_used, None);
        assert!(m.os.is_empty());
    }

    #[test]
    fn parse_metrics_cpu_count_absent_or_zero_is_none() {
        // A host without /proc/stat prints no `ncpu` line at all.
        assert_eq!(parse_metrics("os=Darwin").cpu_count, None);
        assert_eq!(parse_metrics("ncpu=0").cpu_count, None);
        assert_eq!(parse_metrics("ncpu=x").cpu_count, None);
    }

    #[test]
    fn metrics_script_counts_cpus_in_the_same_pass_as_cpustat() {
        // One awk over /proc/stat yields both lines — the logical-CPU count costs
        // no extra process on the per-tick probe.
        assert!(METRICS_SCRIPT.contains("/^cpu[0-9]/{n++}"));
        assert!(METRICS_SCRIPT.contains("ncpu=%d"));
        assert!(!METRICS_SCRIPT.contains("grep '^cpu '"));
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
            "uptime=90061\nswap=4096 3072\nusers=alice bob \nip=10.0.0.5\n\
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
    fn every_process_is_listed_with_its_cpu_now_not_its_lifetime_average() {
        let raw =
            "procfmt=linux\nproclist=2841|1|postgres|Ssl|3542400|12|204800|12.4|postgres\u{1e}\
                   1190|1|app|R|60|8|102400|6.1|tmux: server\u{1e}bad|row\u{1e}\n";
        let rows = parse_proclist(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            ProcRow {
                pid: 2841,
                ppid: Some(1),
                user: "postgres".into(),
                state: "sleeping".into(),
                elapsed_secs: Some(3542400),
                threads: Some(12),
                rss: Some(204800 * 1024),
                mem: 12.4,
                cpu: None,
                comm: "postgres".into(),
            }
        );
        // A name with a space is kept whole.
        assert_eq!(rows[1].comm, "tmux: server");
        // Ticks: user + system, and the start time that tells a reused pid apart.
        let t0 = parse_procticks("procticks=2841 1000 500 77;1190 10 0 88;junk;");
        assert_eq!(t0.get(&2841), Some(&(1500, 77)));
        let t1 = parse_procticks("procticks=2841 1450 550 77;1190 20 0 99;");
        // 500 ticks at 100/s over 5 s — one core flat out for the whole poll.
        let cpu = proc_cpu(&t0, &t1, 5.0, 100.0);
        assert_eq!(cpu.get(&2841), Some(&100.0));
        // Same pid, another start time: a new process, no reading yet.
        assert_eq!(cpu.get(&1190), None);
        assert!(proc_cpu(&t0, &t1, 0.0, 100.0).is_empty());
    }

    #[test]
    fn the_status_bar_names_the_busiest_processes_by_their_cpu_now() {
        // Where `/proc` is, the probe ships every process's ticks; `ps`'s `%cpu`
        // — a lifetime average on Linux — only where it is not.
        let (linux, other) = METRICS_SCRIPT
            .split_once("if [ -r /proc/self/stat ]; then")
            .and_then(|(_, rest)| rest.split_once("else"))
            .expect("the status bar's process reading branches on /proc");
        assert!(linux.contains("topticks=") && linux.contains("/proc/[0-9]*/stat"));
        assert!(
            !linux.contains("pcpu"),
            "the Linux branch must not read ps's %cpu"
        );
        assert!(other.trim_start().starts_with("printf 'topproc="));
        assert_eq!(METRICS_SCRIPT.matches("pcpu").count(), 1);

        // What a real host printed (Debian, mawk): a name with a space and a paren
        // is kept whole; a cut record is dropped.
        let poll = |a: u64, b: u64| {
            format!("clk=100\ntopticks=812 {a} 10 4820100 postgres\u{1e}8 {b} 0 4820808 we ird) x\u{1e}9 1 1\u{1e}\n")
        };
        let (t0, names) = parse_topticks(&poll(1000, 50));
        assert_eq!(names.get(&8).map(String::as_str), Some("we ird) x"));
        assert_eq!(t0.len(), 2);
        let (t1, _) = parse_topticks(&poll(1450, 100));
        // Over 5 s at 100 ticks/s: 450 ticks is 90 % of a core, 50 is 10 %.
        let cpu = proc_cpu(&t0, &t1, 5.0, 100.0);
        assert_eq!(
            local::top_procs_label(&named_cpu(&cpu, &names), 3),
            "postgres 90%, we ird) x 10%"
        );
        // The first poll of a session has no reading: nobody is named.
        assert_eq!(
            local::top_procs_label(&named_cpu(&HashMap::new(), &names), 3),
            ""
        );
        assert!(parse_topticks("topticks=\n").0.is_empty());
    }

    #[test]
    fn the_busiest_six_come_from_the_current_reading() {
        let row = |pid: u32, cpu: Option<f64>, mem: f64| ProcRow {
            pid,
            cpu,
            mem,
            comm: format!("p{pid}"),
            ..Default::default()
        };
        let rows: Vec<ProcRow> = (1..=8)
            .map(|i| {
                row(
                    i,
                    if i == 8 { None } else { Some(i as f64) },
                    (10 - i) as f64,
                )
            })
            .collect();
        let (cpu, mem) = top_of(&rows);
        assert_eq!(
            cpu.iter().map(|p| p.pid).collect::<Vec<_>>(),
            vec![7, 6, 5, 4, 3, 2]
        );
        assert_eq!(
            mem.iter().map(|p| p.pid).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6]
        );
        // The first poll has no CPU reading at all: no CPU six rather than a guess.
        let first: Vec<ProcRow> = rows
            .iter()
            .map(|r| ProcRow {
                cpu: None,
                ..r.clone()
            })
            .collect();
        assert!(top_of(&first).0.is_empty());
    }

    #[test]
    fn a_host_without_proc_lists_its_ps_with_its_recent_cpu() {
        let raw = "procfmt=bsd\nproclist=501|1|boris|S|3.5|1.2|20480|/Applications/Some App.app/x\u{1e}\n";
        let rows = parse_proclist(raw);
        assert_eq!(rows[0].cpu, Some(3.5));
        assert_eq!(rows[0].comm, "/Applications/Some App.app/x");
        assert_eq!((rows[0].elapsed_secs, rows[0].threads), (None, None));
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
    fn parse_detail_does_not_show_a_distorted_mem_available() {
        // total free available buffers cached: 61 GiB "available" of 7.3 GiB.
        // procps-ng shows MemFree in that case, and so does the overlay.
        let d = parse_detail("memdetail=7850684416 217579520 65748795392 4194304 1887436800\n");
        assert_eq!(d.mem_available, Some(217579520));
        assert_eq!(d.mem_total, Some(7850684416));
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
            "clk=",
            "proctotal=",
            "procticks=",
            "proclist=",
            "failed=",
            "listen=",
            "conntrack=",
            "timesync=",
            "netdev=",
            "diskdev=",
            "sessions=",
            "failednames=",
            "vmstat=",
            "pagesize=",
            "cpufreq=",
            "throttle=",
            "listenlist=",
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
            "gpuapps=",
            "docker=",
            "dockerlim=",
            "oomsrc=",
            "oom=",
            "oomkilled=",
            "smart=",
            "loginsok=",
            "logins=",
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
                   oomsrc=journal\n\
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
    fn clear_session_covers_every_field_of_the_struct() {
        // The test below seeds and checks eight stores **by hand**, so adding a
        // ninth field leaks one entry per closed session and that test stays
        // green — which is exactly how the original net/disk leak survived. This
        // one reads the struct instead, so the guard grows with the struct.
        let src = include_str!("mod.rs");
        let decl = src
            .split_once("pub struct MetricsSamples {")
            .expect("struct declaration")
            .1;
        let body = decl.split_once("\n}").expect("struct body").0;

        let fields: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with("//") && !l.starts_with("///"))
            .filter_map(|l| l.split_once(':'))
            .map(|(name, _)| name.trim())
            .filter(|n| !n.is_empty())
            .collect();
        assert!(fields.len() >= 8, "parsed too few fields: {fields:?}");

        let cleared = src
            .split_once("pub fn clear_session(&self, id: &str) {")
            .expect("clear_session body")
            .1;
        let cleared = cleared.split_once("\n    }").expect("end of fn").0;

        let missed: Vec<&&str> = fields
            .iter()
            .filter(|f| !cleared.contains(&format!("self.{f}")))
            .collect();
        assert!(
            missed.is_empty(),
            "clear_session does not clear {missed:?} — each leaks one entry per closed session"
        );
    }

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

    // ── Sections of the monitoring page (1.33): what the new probes read ──────

    #[test]
    fn live_script_runs_in_a_shell_and_emits_keys() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(LIVE_SCRIPT)
            .output()
            .expect("spawn sh");
        assert!(out.status.success(), "LIVE_SCRIPT exited non-zero");
        let text = String::from_utf8_lossy(&out.stdout);
        for key in ["gpu=", "gpuapps=", "docker=", "dockerlim="] {
            assert!(text.contains(key), "LIVE_SCRIPT missing {key}: {text}");
        }
        // The live poll is the changing part only: no SMART, no kernel log.
        assert!(!LIVE_SCRIPT.contains("smartctl") && !LIVE_SCRIPT.contains("journalctl"));
    }

    #[test]
    fn process_script_runs_in_a_shell_and_names_only_the_pid() {
        let script = process_script(std::process::id());
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&script)
            .output()
            .expect("spawn sh");
        assert!(out.status.success(), "process script exited non-zero");
        assert!(String::from_utf8_lossy(&out.stdout).contains("ps="));
        assert!(script.starts_with(&format!("p={}; ", std::process::id())));
    }

    #[test]
    fn parse_detail_reads_failed_units_frequencies_throttling_and_listeners() {
        let raw = "failednames=nginx.service backup.timer \n\
                   cpufreq=10:1200000 2:2400000 0:800000 \n\
                   throttle=17\n\
                   listenlist=tcp|0.0.0.0:22|users:((\"sshd\",pid=812,fd=3));\
                   tcp|[::]:443|;udp|127.0.0.53%lo:53|users:((\"systemd-resolve\",pid=601,fd=13));";
        let d = parse_detail(raw);
        assert_eq!(d.failed_unit_names, vec!["nginx.service", "backup.timer"]);
        // By CPU number, not by the glob's order (cpu10 before cpu2).
        assert_eq!(d.cpu_freq_mhz, vec![800.0, 2400.0, 1200.0]);
        assert_eq!(d.throttle_count, Some(17));
        assert_eq!(d.listen_sockets.len(), 3);
        assert_eq!(
            d.listen_sockets[0],
            ListenSocket {
                proto: "tcp".into(),
                addr: "0.0.0.0".into(),
                port: 22,
                process: Some("sshd".into()),
                pid: Some(812),
            }
        );
        // IPv6 brackets dropped; an owner the session may not see stays unknown.
        assert_eq!(d.listen_sockets[1].addr, "::");
        assert_eq!(d.listen_sockets[1].process, None);
        assert_eq!(d.listen_sockets[2].pid, Some(601));
        // Nothing reported — nothing invented.
        let empty = parse_detail("failednames=\ncpufreq=\nthrottle=\nlistenlist=\n");
        assert!(empty.failed_unit_names.is_empty() && empty.cpu_freq_mhz.is_empty());
        assert_eq!(empty.throttle_count, None);
        assert!(empty.listen_sockets.is_empty());
    }

    #[test]
    fn disk_counters_give_utilization_and_latency_only_from_completed_requests() {
        let ticks = parse_diskticks("diskdev=sda,10,20,100,200,300,400,500;sdb,1,2;");
        assert_eq!(ticks.len(), 1, "a 3-field record carries no counters");
        let prev = ticks[0].1;
        assert_eq!(
            prev,
            DiskTicks {
                reads: 100,
                writes: 200,
                read_ms: 300,
                write_ms: 400,
                busy_ms: 500,
            }
        );
        // 2 s later: busy 1000 ms of 2000 → 50%; 40 requests took 200 ms → 5 ms each.
        let cur = DiskTicks {
            reads: 120,
            writes: 220,
            read_ms: 380,
            write_ms: 520,
            busy_ms: 1500,
        };
        assert_eq!(disk_latency(&prev, &cur, 2.0), (Some(50.0), Some(5.0)));
        // An idle device: 0% busy, and no latency to report rather than "0 ms".
        assert_eq!(disk_latency(&prev, &prev, 2.0), (Some(0.0), None));
        // No time between samples — nothing to say.
        assert_eq!(disk_latency(&prev, &cur, 0.0), (None, None));
        // The rate parser still reads the bytes of the 8-field record.
        assert_eq!(
            parse_diskdev("diskdev=sda,10,20,1,2,3,4,5;"),
            vec![("sda".into(), 5120, 10240)]
        );
    }

    #[test]
    fn the_oom_count_is_unknown_when_the_kernel_log_could_not_be_read() {
        // Live violation of the old probe: `dmesg` restricted → grep counted an
        // empty input → "0 OOM kills", a reading nobody took.
        let e = parse_extras("oomsrc=\noom=0\noomkilled=\n");
        assert_eq!(e.oom_kills, None);
        assert!(e.oom_victims.is_empty());
        let e = parse_extras(
            "oomsrc=journal\noom=2\noomkilled=2026-11-05T09:14:22+0000 web kernel: Out of memory: \
             Killed process 2841 (postgres) total-vm:1kB\u{1e}[ 5123.25] Killed process 77 (node) anon-rss:1kB\u{1e}\n",
        );
        assert_eq!(e.oom_kills, Some(2));
        assert_eq!(
            e.oom_victims,
            vec![
                OomVictim {
                    pid: Some(2841),
                    name: "postgres".into(),
                    at: Some("2026-11-05T09:14:22+0000".into()),
                    boot_secs: None,
                },
                OomVictim {
                    pid: Some(77),
                    name: "node".into(),
                    at: None,
                    boot_secs: Some(5123.25),
                },
            ]
        );
    }

    #[test]
    fn gpus_carry_power_clocks_and_their_processes() {
        let raw = "gpu=Tesla T4|41|6200|15360|52|31.5|70.00|1590|5000|00000000:00:1E.0;\
                   Tesla T4|0|0|15360|30|[N/A]|[N/A]|[N/A]|[N/A]|00000000:00:1F.0;\n\
                   gpuapps=00000000:00:1E.0|2841|/usr/bin/python3|6100;\
                   00000000:00:FF.0|9|ghost|1;\n";
        let g = parse_gpus(raw);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].power_draw, Some(31.5));
        assert_eq!(g[0].power_limit, Some(70.0));
        assert_eq!(g[0].clock_sm, Some(1590.0));
        assert_eq!(
            g[0].procs,
            vec![GpuProc {
                pid: 2841,
                name: "/usr/bin/python3".into(),
                mem_mib: Some(6100),
            }]
        );
        // `[N/A]` is unknown, and a process on a bus no GPU listed goes nowhere.
        assert_eq!(g[1].power_draw, None);
        assert!(g[1].procs.is_empty());
        // The older 5-field record still reads.
        assert_eq!(parse_gpus("gpu=A|1|2|3|4;").len(), 1);
    }

    #[test]
    fn containers_show_a_share_only_against_a_limit_that_was_set() {
        let raw = "docker=api|62.4|1.21GiB / 2GiB;pg|38.0|2.03GiB / 15.6GiB;\n\
                   dockerlim=/api|2147483648|1500000000;/pg|0|0;\n";
        let d = parse_docker(raw);
        assert_eq!(d[0].mem_used, Some((1.21 * 1024f64.powi(3)) as u64));
        assert_eq!(d[0].mem_limit, Some(2147483648));
        assert_eq!(d[0].cpu_limit, Some(1.5));
        // No limit: docker shows the host's memory — that is not a ceiling.
        assert_eq!(d[1].mem_limit, None);
        assert_eq!(d[1].cpu_limit, None);
        assert_eq!(parse_size("512MiB"), Some(512 * 1024 * 1024));
        assert_eq!(parse_size("12.5kB"), Some(12500));
        assert_eq!(parse_size("0B"), Some(0));
        assert_eq!(parse_size("lots"), None);
    }

    #[test]
    fn smart_wear_is_the_share_used_whichever_way_the_disk_reports_it() {
        let s = parse_smart(
            "smart=nvme0n1|PASSED|41|18220|used:3|;sda|PASSED|34|41007|left:95|12;sdb|PASSED|30|1;",
        );
        assert_eq!(s[0].wear_pct, Some(3.0));
        assert_eq!(s[0].reallocated, None);
        assert_eq!(s[1].wear_pct, Some(5.0));
        assert_eq!(s[1].reallocated, Some(12));
        assert_eq!(s[2].wear_pct, None, "the older 4-field record has no wear");
        assert_eq!(wear_used("left:120"), Some(0.0));
        assert_eq!(wear_used("bogus"), None);
    }

    #[test]
    fn logins_are_unknown_when_last_could_not_be_read() {
        assert_eq!(parse_logins("loginsok=\nlogins=\n"), None);
        let l = parse_logins(
            "loginsok=1\nlogins=deploy|pts/0|10.0.0.12|2026-11-05T09:14:22+00:00|1;root|pts/1|10.0.0.31|2026-11-04T13:52:01+00:00|0;\n",
        )
        .unwrap();
        assert_eq!(l.len(), 2);
        assert!(l[0].active && !l[1].active);
        assert_eq!(l[1].from, "10.0.0.31");
        assert_eq!(parse_logins("loginsok=1\nlogins=\n"), Some(Vec::new()));
    }

    #[test]
    fn a_process_is_read_once_and_gone_means_none() {
        let raw = "alive=1\nps=postgres Ssl 4521 12 204800\nargs=postgres: checkpointer\nfds=57\n";
        assert_eq!(
            parse_process(raw, 2841),
            Some(ProcessDetail {
                pid: 2841,
                user: "postgres".into(),
                state: "sleeping".into(),
                elapsed_secs: Some(4521),
                threads: Some(12),
                rss: Some(204800 * 1024),
                cmdline: "postgres: checkpointer".into(),
                fds: Some(57),
            })
        );
        assert_eq!(parse_process("ps=\nargs=\n", 9), None);
        // Alive but `ps` could not say (busybox): the fields are unknown, not zero.
        let p = parse_process("alive=1\nps=\nargs=\n", 9).unwrap();
        assert_eq!(
            (p.elapsed_secs, p.threads, p.rss, p.fds),
            (None, None, None, None)
        );
        assert_eq!(ps_state("D+"), "disk");
        assert_eq!(ps_state("Z"), "zombie");
        assert_eq!(ps_state(""), "");
    }
}
