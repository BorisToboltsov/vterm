// Live SSH/local session: connect, terminal I/O, disconnect, term event names,
// and the status-bar/monitoring metric probes (mirror of metrics.rs types).
import { invoke } from "@tauri-apps/api/core";

// ── SSH session ───────────────────────────────────────────────────────────────

export interface ConnectPlan {
  /** Whether the UI must prompt for a secret before connecting. */
  needsSecret: boolean;
  /** "Password" or "Passphrase" — label for the prompt. */
  secretLabel: string;
}

/** Ask the backend whether connecting needs a typed secret (or keychain has it). */
export function connectPlan(id: string): Promise<ConnectPlan> {
  return invoke<ConnectPlan>("connect_plan", { id });
}

/**
 * Open an SSH session for `serverId` under the per-tab `sessionId`.
 * `secret` is the just-typed password/passphrase (or null to use the keychain);
 * `remember` stores it in the OS keychain.
 */
export interface ConnectOptions {
  termType: string;
  connectTimeout: number;
  keepaliveInterval: number;
  hostKeyPolicy: string;
}

export function connectSession(
  sessionId: string,
  serverId: string,
  secret: string | null,
  remember: boolean,
  cols: number,
  rows: number,
  opts: ConnectOptions,
): Promise<void> {
  return invoke<void>("connect_session", {
    sessionId,
    serverId,
    secret,
    remember,
    cols,
    rows,
    termType: opts.termType,
    connectTimeout: opts.connectTimeout,
    keepaliveInterval: opts.keepaliveInterval,
    hostKeyPolicy: opts.hostKeyPolicy,
  });
}

/** Open a local-shell terminal (a PTY on the machine running vterm). */
export function openLocalTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("open_local_terminal", { sessionId, cols, rows });
}

/** Send user keystrokes (UTF-8 bytes) to the remote shell. */
export function writeToTerminal(
  sessionId: string,
  data: Uint8Array,
): Promise<void> {
  return invoke<void>("write_to_terminal", {
    sessionId,
    data: Array.from(data),
  });
}

/** Inform the remote PTY of a new terminal size. */
export function resizePty(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("resize_pty", { sessionId, cols, rows });
}

/** Close an active session. */
export function disconnect(sessionId: string): Promise<void> {
  return invoke<void>("disconnect", { sessionId });
}

/** Remote host metrics for the bottom status bar. */
export interface Metrics {
  os: string;
  prettyName: string;
  hostname: string;
  user: string;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpuPct: number | null;
  memUsed: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  /** Network throughput in bytes/sec (download = rx, upload = tx). */
  netRxRate: number | null;
  netTxRate: number | null;
  /** Disk I/O in bytes/sec. */
  diskReadRate: number | null;
  diskWriteRate: number | null;
  uptimeSecs: number | null;
  swapUsed: number | null;
  swapTotal: number | null;
  /** Space-separated logged-in usernames. */
  users: string;
  ip: string;
  /** Top CPU process, e.g. "node 87%". */
  topProc: string;
  cpuTemp: number | null;
  netConns: number | null;
  kernel: string;
  /** Remote clock + timezone, e.g. "14:05 UTC". */
  serverTime: string;
}

/** Probe the active session for OS info and resource usage. */
export function fetchMetrics(sessionId: string): Promise<Metrics> {
  return invoke<Metrics>("fetch_metrics", { sessionId });
}

/** Pressure Stall Information `some` averages (10/60/300 s windows). */
export interface Psi {
  avg10: number;
  avg60: number;
  avg300: number;
}

/** A mounted filesystem with space and (optionally) inode usage. */
export interface Partition {
  mount: string;
  fstype: string;
  used: number;
  total: number;
  inodesUsed: number | null;
  inodesTotal: number | null;
}

export interface TcpState {
  state: string;
  count: number;
}

/** One temperature sensor reading from lm-sensors. */
export interface Sensor {
  label: string;
  temp: number;
  high: number | null;
  crit: number | null;
}

/** CPU time breakdown over the last interval (percentages). */
export interface CpuBreakdown {
  user: number;
  system: number;
  iowait: number;
  steal: number;
  idle: number;
}

/** One process row for the top-CPU table. */
export interface Proc {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  comm: string;
}

/** Per-interface network: rx/tx bytes/sec + cumulative error/drop counters. */
export interface NetIface {
  name: string;
  rxRate: number;
  txRate: number;
  rxErrs: number;
  rxDrop: number;
  txErrs: number;
  txDrop: number;
}

/** Per-device disk throughput (bytes/sec). */
export interface DiskDev {
  name: string;
  readRate: number;
  writeRate: number;
}

/** One logged-in session from `who`. */
export interface Session {
  user: string;
  tty: string;
  from: string;
  login: string;
}

/** Heavier per-page metrics, fetched only while the monitoring overlay is open. */
export interface MetricsDetail {
  /** Per-core CPU utilization 0–100 (empty until the second poll). */
  perCpu: number[];
  memTotal: number | null;
  memFree: number | null;
  memAvailable: number | null;
  memBuffers: number | null;
  memCached: number | null;
  /** Top processes by memory, e.g. "node 12%, postgres 8%". */
  topMem: string;
  partitions: Partition[];
  /** System-wide open file descriptors vs the `fs.file-max` ceiling. */
  fileNrUsed: number | null;
  fileNrMax: number | null;
  ulimitSoft: number | null;
  ulimitHard: number | null;
  psiCpu: Psi | null;
  psiMem: Psi | null;
  psiIo: Psi | null;
  tcp: TcpState[];
  /** Temperature sensors (lm-sensors); empty when `sensors` isn't installed. */
  sensors: Sensor[];
  /** Whether the `sensors` binary exists — distinguishes "not installed" (offer
   *  install) from "installed but no chips detected". */
  sensorsInstalled: boolean;
  /** CPU time split (user/system/iowait/steal/idle %); null on the first poll. */
  cpuBreakdown: CpuBreakdown | null;
  /** Top processes by CPU. */
  topProcs: Proc[];
  /** Top processes by memory (same shape, sorted by %MEM). */
  topMemProcs: Proc[];
  failedUnits: number | null;
  listenPorts: number | null;
  conntrack: number | null;
  conntrackMax: number | null;
  timeSynced: boolean | null;
  /** Per-interface network, per-device disk I/O, and logged-in sessions. */
  netIfaces: NetIface[];
  diskDevs: DiskDev[];
  sessions: Session[];
  ctxtRate: number | null;
  intrRate: number | null;
  procsRunning: number | null;
  procsBlocked: number | null;
}

/** Detailed metrics for the monitoring overlay (heavier than `fetchMetrics`). */
export function fetchMetricsDetail(sessionId: string): Promise<MetricsDetail> {
  return invoke<MetricsDetail>("fetch_metrics_detail", { sessionId });
}

/** Pending OS package updates + reboot-required flag. */
export interface PendingUpdates {
  manager: string;
  updates: number | null;
  security: number | null;
  rebootRequired: boolean;
}

/** Lazily probe pending package updates (heavy — overlay only, deferred). */
export function fetchPendingUpdates(sessionId: string): Promise<PendingUpdates> {
  return invoke<PendingUpdates>("fetch_pending_updates", { sessionId });
}

/** An NVIDIA GPU (nvidia-smi); VRAM is in MiB. */
export interface Gpu {
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
}

/** A running Docker container's live stats. */
export interface DockerStat {
  name: string;
  cpu: number;
  mem: string;
}

/** One disk's SMART summary (smartctl). */
export interface SmartDisk {
  device: string;
  health: string;
  temp: number | null;
  powerOnHours: number | null;
}

/** Static machine spec (mirrors metrics.rs `Hardware`); all best-effort/root-free. */
export interface Hardware {
  cpuModel: string;
  /** Physical cores (cores-per-socket × sockets) and logical threads. */
  cpuCores: number | null;
  cpuThreads: number | null;
  cpuSockets: number | null;
  /** Max CPU frequency in MHz (falls back to current when max is unavailable). */
  cpuMhz: number | null;
  arch: string;
  /** systemd-detect-virt output ("none" on bare metal). */
  virt: string;
  machine: string;
  /** DMI baseboard/motherboard (vendor + name). */
  board: string;
  bios: string;
}

/** Optional extras probed once on overlay open (GPU/Docker/SMART/OOM + hardware). */
export interface Extras {
  gpus: Gpu[];
  docker: DockerStat[];
  smart: SmartDisk[];
  oomKills: number | null;
  /** Optional on the wire only defensively — the backend always sends it. */
  hardware?: Hardware;
}

/** Lazily probe optional extras (heavy/optional — overlay only, deferred). */
export function fetchExtras(sessionId: string): Promise<Extras> {
  return invoke<Extras>("fetch_extras", { sessionId });
}

/** Event name carrying raw output bytes for a session (mirrors ssh.rs). */
export const outputEvent = (sessionId: string) => `term://out/${sessionId}`;
/** Event name signalling the session closed. */
export const closedEvent = (sessionId: string) => `term://closed/${sessionId}`;
/** Event name carrying SSH connection-phase progress (mirrors ssh.rs). */
export const phaseEvent = (sessionId: string) => `term://phase/${sessionId}`;
/** Event name carrying live server-tool install output chunks (mirrors ssh.rs). */
export const installOutputEvent = (sessionId: string) => `install://out/${sessionId}`;
