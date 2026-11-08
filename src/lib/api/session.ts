// Live SSH/local session: connect, terminal I/O, disconnect, term event names,
// and the status-bar/monitoring metric probes (mirror of metrics.rs types).
import { invoke } from "@tauri-apps/api/core";
import { createOrderedWriter } from "../terminal/termwrite";

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

/** What happened besides the connection itself — the session is up either way. */
export interface ConnectOutcome {
  /** Why "remember" did not persist the secret (e.g. no keychain), if it did not. */
  rememberFailed: string | null;
}

export function connectSession(
  sessionId: string,
  serverId: string,
  secret: string | null,
  remember: boolean,
  cols: number,
  rows: number,
  opts: ConnectOptions,
): Promise<ConnectOutcome> {
  return invoke<ConnectOutcome>("connect_session", {
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

/**
 * Open a local-shell terminal (a PTY on the machine running vterm). `shell` is an
 * explicit program/path (Windows cmd/PowerShell/pwsh preset or a custom path);
 * `null` lets the backend use the OS default ($SHELL / %ComSpec%). `cwd`: the
 * folder to start in — a tab of the previous launch comes back where its shell
 * was (v1.36); the backend takes it only when it is an existing folder, else home.
 */
export function openLocalTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  shell: string | null = null,
  cwd: string | null = null,
): Promise<void> {
  return invoke<void>("open_local_terminal", { sessionId, cols, rows, shell, cwd });
}

/**
 * Send user keystrokes (UTF-8 bytes) to the remote shell. `setup`: the line is
 * path sync's own setup command, not one of the user's.
 */
export function writeToTerminal(
  sessionId: string,
  data: Uint8Array,
  setup = false,
): Promise<void> {
  const written = orderedWrite(sessionId, data);
  // A line was sent — typed, pasted, broadcast, run by the assistant: every
  // way input reaches a session passes here (lint rule `vterm/terminal-write`).
  if (data.includes(CR)) submitListeners.get(sessionId)?.forEach((cb) => cb(written, setup));
  return written;
}

const CR = 0x0d;
const submitListeners = new Map<string, Set<(written: Promise<void>, setup: boolean) => void>>();

/**
 * Call `cb` whenever input carrying Enter (CR) is sent to the session — with
 * the write, which settles once the bytes reached it, and whether the line is
 * path sync's setup command. Where a command ran is noted from here (v1.24,
 * file links in output). Returns the unsubscribe.
 */
export function onSessionSubmit(
  sessionId: string,
  cb: (written: Promise<void>, setup: boolean) => void,
): () => void {
  let set = submitListeners.get(sessionId);
  if (!set) submitListeners.set(sessionId, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0 && submitListeners.get(sessionId) === set) submitListeners.delete(sessionId);
  };
}

/** Per-session sequential delivery — concurrent invokes may land out of order (termwrite.ts). */
const orderedWrite = createOrderedWriter((sessionId, data) =>
  invoke<void>("write_to_terminal", {
    sessionId,
    data: Array.from(data),
  }),
);

/**
 * Read the current session's shell history file (raw text) for the Ctrl+R
 * command-history overlay. Parsing lives in `history.ts`.
 */
export function readShellHistory(sessionId: string): Promise<string> {
  return invoke<string>("read_shell_history", { sessionId });
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

/** Answer the server's login questions for `sessionId` (in the order shown), or
 *  `null` to cancel the login. The answers are never stored (kbdauth.rs). */
export function answerAuthPrompt(sessionId: string, answers: string[] | null): Promise<void> {
  return invoke<void>("answer_auth_prompt", { sessionId, answers });
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
  /** Logical CPUs — the ceiling a load average is read against; null = unknown. */
  cpuCount: number | null;
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
  /** Share of wall time the device had I/O in flight, 0–100; null on the first poll. */
  utilPct: number | null;
  /** Average time per completed read or write, ms; null when nothing completed. */
  awaitMs: number | null;
}

/** A listening TCP/UDP socket (`ss -tulnp`); the owner only when the session may see it. */
export interface ListenSocket {
  proto: string;
  addr: string;
  port: number;
  process: string | null;
  pid: number | null;
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
  /** Names of failed systemd units (at most 20). */
  failedUnitNames: string[];
  /** Swap traffic, bytes/s paged in and out; null on the first poll or when unreported. */
  swapInRate: number | null;
  swapOutRate: number | null;
  /** Current MHz of each logical CPU; empty where cpufreq is not exposed. */
  cpuFreqMhz: number[];
  /** Thermal-throttling events since boot; null when the kernel does not expose them. */
  throttleCount: number | null;
  /** Listening TCP/UDP sockets (at most 200). */
  listenSockets: ListenSocket[];
  /** Every process (at most 3000) — only when asked for (`fetchMetricsDetail(id, true)`). */
  processes: ProcRow[];
  /** How many processes the host has; may exceed `processes.length`. */
  processTotal: number | null;
}

/** One process of the full list. `cpu` — % of one core over the last poll; null on the first. */
export interface ProcRow {
  pid: number;
  ppid: number | null;
  user: string;
  state: ProcessDetail["state"];
  elapsedSecs: number | null;
  threads: number | null;
  /** Resident memory, bytes. */
  rss: number | null;
  /** Resident memory, % of RAM. */
  mem: number;
  cpu: number | null;
  comm: string;
}

/** Detailed metrics for the monitoring overlay (heavier than `fetchMetrics`). */
export function fetchMetricsDetail(sessionId: string, processes = false): Promise<MetricsDetail> {
  return invoke<MetricsDetail>("fetch_metrics_detail", { sessionId, processes });
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
  /** Power draw and the board's limit, W; null where the driver reports none. */
  powerDraw: number | null;
  powerLimit: number | null;
  /** Graphics and memory clocks, MHz. */
  clockSm: number | null;
  clockMem: number | null;
  procs: GpuProc[];
}

/** A process using a GPU (`nvidia-smi --query-compute-apps`). */
export interface GpuProc {
  pid: number;
  name: string;
  memMib: number | null;
}

/** A running Docker container's live stats. */
export interface DockerStat {
  name: string;
  /** CPU, % of one core (`docker stats`). */
  cpu: number;
  mem: string;
  /** Memory in use, bytes. */
  memUsed: number | null;
  /** Configured memory limit, bytes; null when none is set. */
  memLimit: number | null;
  /** Configured CPU limit, cores; null when none is set. */
  cpuLimit: number | null;
}

/** One disk's SMART summary (smartctl). */
export interface SmartDisk {
  device: string;
  health: string;
  temp: number | null;
  powerOnHours: number | null;
  /** Share of the rated endurance used, %. */
  wearPct: number | null;
  /** ATA reallocated sectors; null for NVMe and unreported. */
  reallocated: number | null;
}

/** A process the OOM killer ended in this boot. */
export interface OomVictim {
  pid: number | null;
  name: string;
  /** ISO time from the journal; null when read from `dmesg`. */
  at: string | null;
  /** Seconds since boot from `dmesg`; null when read from the journal. */
  bootSecs: number | null;
}

/** A recent login (`last`), newest first. */
export interface Login {
  user: string;
  tty: string;
  from: string;
  /** ISO time. */
  at: string;
  active: boolean;
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
  /** OOM events this boot; null when the kernel log could not be read. */
  oomKills: number | null;
  oomVictims: OomVictim[];
  /** The last logins; null when `last` is missing or unreadable. */
  logins: Login[] | null;
  /** Optional on the wire only defensively — the backend always sends it. */
  hardware?: Hardware;
}

/** Lazily probe optional extras (heavy/optional — overlay only, deferred). */
export function fetchExtras(sessionId: string): Promise<Extras> {
  return invoke<Extras>("fetch_extras", { sessionId });
}

/** The part of the extras that changes by the second (GPUs, containers). */
export interface LiveExtras {
  gpus: Gpu[];
  docker: DockerStat[];
}

/** Poll GPUs and containers — only while their monitoring section is on screen. */
export function fetchLiveExtras(sessionId: string): Promise<LiveExtras> {
  return invoke<LiveExtras>("fetch_live_extras", { sessionId });
}

/** One process, read on a click. `state` is an English key the page localizes. */
export interface ProcessDetail {
  pid: number;
  user: string;
  state: "running" | "sleeping" | "disk" | "stopped" | "zombie" | "idle" | "other" | "";
  elapsedSecs: number | null;
  threads: number | null;
  /** Resident memory, bytes. */
  rss: number | null;
  cmdline: string;
  fds: number | null;
}

/** Read one process's details; null when it is gone. */
export function fetchProcessDetail(sessionId: string, pid: number): Promise<ProcessDetail | null> {
  return invoke<ProcessDetail | null>("fetch_process_detail", { sessionId, pid });
}

/** Event name carrying raw output bytes for a session (mirrors ssh.rs). */
export const outputEvent = (sessionId: string) => `term://out/${sessionId}`;
/** Event name signalling the session closed. */
export const closedEvent = (sessionId: string) => `term://closed/${sessionId}`;
/** Event name carrying SSH connection-phase progress (mirrors ssh.rs). */
export const phaseEvent = (sessionId: string) => `term://phase/${sessionId}`;
/** Event name carrying the server's keyboard-interactive login questions
 *  (mirrors kbdauth.rs `auth_event`). */
export const authEvent = (sessionId: string) => `term://auth/${sessionId}`;
/** Event name carrying live server-tool install output chunks (mirrors ssh.rs). */
export const installOutputEvent = (sessionId: string) => `install://out/${sessionId}`;
