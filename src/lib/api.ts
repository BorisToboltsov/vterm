// Thin typed wrappers around Tauri `invoke`. All backend access goes through here
// so the UI never deals with command-name strings directly.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { FileEntry, NewServerProfile, ServerProfile } from "./types";

// ── Server profiles ───────────────────────────────────────────────────────────

export function listServers(): Promise<ServerProfile[]> {
  return invoke<ServerProfile[]>("list_servers");
}

export function addServer(profile: NewServerProfile): Promise<ServerProfile> {
  return invoke<ServerProfile>("add_server", { profile });
}

export function updateServer(
  id: string,
  profile: NewServerProfile,
): Promise<ServerProfile> {
  return invoke<ServerProfile>("update_server", { id, profile });
}

export function deleteServer(id: string): Promise<void> {
  return invoke<void>("delete_server", { id });
}

/** Forget any stored password/passphrase for a server. */
export function forgetSecrets(id: string): Promise<void> {
  return invoke<void>("forget_secrets", { id });
}

// ── Folders ─────────────────────────────────────────────────────────────────

/** All folder paths ("/"-separated, e.g. "Production/EU"). */
export function listFolders(): Promise<string[]> {
  return invoke<string[]>("list_folders");
}

/** Create a folder (and any missing ancestors); returns the full folder list. */
export function addFolder(path: string): Promise<string[]> {
  return invoke<string[]>("add_folder", { path });
}

/** Delete a folder and its descendants; servers inside move to the root. */
export function deleteFolder(path: string): Promise<void> {
  return invoke<void>("delete_folder", { path });
}

/** Move a folder (with its subtree) under newParent (null/empty = root). */
export function moveFolder(
  path: string,
  newParent: string | null,
): Promise<void> {
  return invoke<void>("move_folder", { path, newParent });
}

/** Rename a folder in place (keeps its parent), renaming its whole subtree. */
export function renameFolder(path: string, newName: string): Promise<void> {
  return invoke<void>("rename_folder", { path, newName });
}

/** Move a server into a folder (null/empty = root). */
export function setServerGroup(
  id: string,
  group: string | null,
): Promise<ServerProfile> {
  return invoke<ServerProfile>("set_server_group", { id, group });
}

// ── Backup (export / import) ───────────────────────────────────────────────────

/** Result of importing a backup. `settings` is the opaque UI settings snapshot. */
export interface ImportResult {
  serverCount: number;
  folderCount: number;
  settings: unknown | null;
}

/**
 * Write a backup (servers + folders + UI settings) to `path` as JSON. Secrets are
 * never exported — they stay in the OS keychain.
 */
export function exportBackup(path: string, settings: unknown): Promise<void> {
  return invoke<void>("export_backup", { path, settings });
}

/** Restore a backup from `path`, replacing the current servers and folders. */
export function importBackup(path: string): Promise<ImportResult> {
  return invoke<ImportResult>("import_backup", { path });
}

/** Native "save as" dialog for a backup file; returns the chosen path or null. */
export function pickBackupSavePath(defaultName: string): Promise<string | null> {
  return save({
    defaultPath: defaultName,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
}

/** Native open dialog for a backup file; returns the chosen path or null. */
export async function pickBackupFile(): Promise<string | null> {
  const res = await open({
    multiple: false,
    directory: false,
    title: "Import backup",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  return typeof res === "string" ? res : null;
}

/** Open a native file picker for a private key; returns the chosen path or null. */
export async function pickKeyFile(): Promise<string | null> {
  const res = await open({
    multiple: false,
    directory: false,
    title: "Select private key",
  });
  return typeof res === "string" ? res : null;
}

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

/** Event name carrying raw output bytes for a session (mirrors ssh.rs). */
export const outputEvent = (sessionId: string) => `term://out/${sessionId}`;
/** Event name signalling the session closed. */
export const closedEvent = (sessionId: string) => `term://closed/${sessionId}`;

// ── SFTP ──────────────────────────────────────────────────────────────────────

export function sftpHome(sessionId: string): Promise<string> {
  return invoke<string>("sftp_home", { sessionId });
}

export function sftpList(sessionId: string, path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("sftp_list", { sessionId, path });
}

export function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke<void>("sftp_mkdir", { sessionId, path });
}

export function sftpCreateFile(sessionId: string, path: string): Promise<void> {
  return invoke<void>("sftp_create_file", { sessionId, path });
}

export function sftpDelete(
  sessionId: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  return invoke<void>("sftp_delete", { sessionId, path, isDir });
}

export function sftpUpload(
  sessionId: string,
  transferId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return invoke<void>("sftp_upload", {
    sessionId,
    transferId,
    localPath,
    remotePath,
  });
}

export function sftpDownload(
  sessionId: string,
  transferId: string,
  remotePath: string,
  localPath: string,
  isDir: boolean,
): Promise<void> {
  return invoke<void>("sftp_download", {
    sessionId,
    transferId,
    remotePath,
    localPath,
    isDir,
  });
}

/** Pick one or more local files to upload; returns absolute paths. */
export async function pickUploadFiles(): Promise<string[]> {
  const res = await open({ multiple: true, directory: false, title: "Upload files" });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

/** Pick a local destination path for a file download. */
export function pickSavePath(defaultName: string): Promise<string | null> {
  return save({ defaultPath: defaultName });
}

/** Pick a local destination directory (for folder downloads). */
export async function pickSaveDir(): Promise<string | null> {
  const res = await open({
    directory: true,
    multiple: false,
    title: "Download folder to…",
  });
  return typeof res === "string" ? res : null;
}

export interface SftpProgress {
  id: string;
  name: string;
  direction: "upload" | "download";
  /** Bytes for single files; completed-file count for folders. */
  transferred: number;
  /** Total bytes for single files; total file count for folders. */
  total: number;
  done: boolean;
  /** True for aggregate folder downloads (transferred/total are file counts). */
  isFolder: boolean;
}

/** Cancel an in-progress folder download. */
export function sftpCancel(transferId: string): Promise<void> {
  return invoke<void>("sftp_cancel", { transferId });
}

/**
 * Read clipboard text in the Rust process (macOS NSPasteboard). Bypasses
 * WKWebView so `navigator.clipboard.readText()`'s "Paste" prompt never appears.
 * Rejects on platforms without a native reader so the caller can fall back.
 */
export function readClipboardText(): Promise<string> {
  return invoke<string>("read_clipboard_text");
}

// ── Native menu ───────────────────────────────────────────────────────────────

/** Localized labels for the native application menu (mirrors `MenuLabels` in Rust). */
export interface MenuLabels {
  fileMenu: string;
  helpMenu: string;
  settings: string;
  about: string;
  help: string;
  manual: string;
  monitoring: string;
}

/** Rebuild the native menu in the given language (called on startup + on change). */
export function setMenuLanguage(labels: MenuLabels): Promise<void> {
  return invoke<void>("set_menu_language", { labels });
}
