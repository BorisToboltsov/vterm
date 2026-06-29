// Thin typed wrappers around Tauri `invoke`. All backend access goes through here
// so the UI never deals with command-name strings directly.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  FileEntry,
  NewServerProfile,
  RecordingMeta,
  ServerProfile,
  TextFile,
  WriteResult,
} from "./types";

import type { HashEntry, SyncAction, SyncStats, GrepMatch } from "./sync";
import type { RemoteLintResult } from "./remotelint";
import type { ToolsStatus } from "./servertools";

/** Marker (in `AppError::FileChangedOnServer`) that a save lost a race. */
export const FILE_CHANGED_MARKER = "file-changed";

/** True when a thrown invoke error means the file changed on the server. */
export function isFileChangedError(err: unknown): boolean {
  return String(err).includes(FILE_CHANGED_MARKER);
}

/**
 * True when a remote read/write failed because the path isn't accessible to the
 * user — i.e. sudo could help. Covers both "Permission denied" and "No such file":
 * some SFTP servers report a write into a non-writable directory (the staging temp)
 * as `No such file` rather than `Permission denied`. The file is known to exist
 * (it was listed / just opened), so either ⇒ an access problem, not a missing file.
 */
export function isPermissionError(err: unknown): boolean {
  return /permission denied|no such file/i.test(String(err));
}

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

/** Which data sections a backup carries — also the export preset the user picks. */
export type BackupKind = "servers" | "settings" | "recordings" | "all";

/**
 * Result of importing a backup. Each section count is `null` when the backup
 * didn't include it (so the UI reports only what was restored). `kind` echoes the
 * backup's declared kind; `settings` is the opaque UI snapshot to apply (if any).
 */
export interface ImportResult {
  kind: BackupKind;
  servers: number | null;
  folders: number | null;
  recordings: number | null;
  settings: unknown | null;
}

/**
 * Write a backup `.zip` archive to `path`. `kind` chooses which sections go in
 * (servers + folders, UI settings, recordings, or all). Secrets are never
 * exported — they stay in the OS keychain.
 */
export function exportBackup(path: string, kind: BackupKind, settings: unknown): Promise<void> {
  return invoke<void>("export_backup", { path, kind, settings });
}

/**
 * Restore a backup from `path`. The backend auto-detects the format (`.zip`
 * archive or legacy `.json`) and restores exactly the sections it contains.
 */
export function importBackup(path: string): Promise<ImportResult> {
  return invoke<ImportResult>("import_backup", { path });
}

/** Native "save as" dialog for a backup archive; returns the chosen path or null. */
export function pickBackupSavePath(defaultName: string): Promise<string | null> {
  return save({
    defaultPath: defaultName,
    filters: [{ name: "vterm backup", extensions: ["zip"] }],
  });
}

/** Native open dialog for a backup file; returns the chosen path or null. */
export async function pickBackupFile(): Promise<string | null> {
  const res = await open({
    multiple: false,
    directory: false,
    title: "Import backup",
    // Accept the current .zip archives and legacy .json backups.
    filters: [{ name: "vterm backup", extensions: ["zip", "json"] }],
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
/** Event name carrying SSH connection-phase progress (mirrors ssh.rs). */
export const phaseEvent = (sessionId: string) => `term://phase/${sessionId}`;

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

/**
 * Open a remote file as text in the editor (throws on large/binary files).
 * `maxBytes` is the configured open-size limit (backend clamps it to a hard cap).
 */
export function sftpReadText(
  sessionId: string,
  path: string,
  maxBytes?: number,
  sudo?: boolean,
  sudoPassword?: string,
): Promise<TextFile> {
  return invoke<TextFile>("sftp_read_text", { sessionId, path, maxBytes, sudo, sudoPassword });
}

/** Open a LOCAL file as text in the editor (throws on large/binary files). */
export function readLocalText(path: string, maxBytes?: number): Promise<TextFile> {
  return invoke<TextFile>("read_local_text", { path, maxBytes });
}

/** Save editor text back to a LOCAL file (atomic, conflict-checked). */
export function writeLocalText(
  path: string,
  content: string,
  eol: "lf" | "crlf",
  expectedSha256: string | null,
): Promise<WriteResult> {
  return invoke<WriteResult>("write_local_text", { path, content, eol, expectedSha256 });
}

/** Drain the queue of files vterm was asked to open (CLI args / macOS Opened). */
export function takePendingOpens(): Promise<string[]> {
  return invoke<string[]>("take_pending_opens");
}

// ── Local filesystem browser (right panel for local-terminal tabs) ──────────────

export function localHome(): Promise<string> {
  return invoke<string>("local_home");
}

export function localList(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("local_list", { path });
}

export function localMkdir(path: string): Promise<void> {
  return invoke<void>("local_mkdir", { path });
}

export function localCreateFile(path: string): Promise<void> {
  return invoke<void>("local_create_file", { path });
}

export function localDelete(path: string, isDir: boolean): Promise<void> {
  return invoke<void>("local_delete", { path, isDir });
}

// ── Directory sync (Phase 12.5) ─────────────────────────────────────────────────

/** Hash a remote directory tree via sha256sum over SSH (no download). */
export function sftpHashTree(sessionId: string, path: string): Promise<HashEntry[]> {
  return invoke<HashEntry[]>("sftp_hash_tree", { sessionId, path });
}

/** Hash a local directory tree. */
export function localHashTree(path: string): Promise<HashEntry[]> {
  return invoke<HashEntry[]>("local_hash_tree", { path });
}

/** Detect the server's package manager + which optional tools are installed. */
export function serverToolsStatus(sessionId: string): Promise<ToolsStatus> {
  return invoke<ToolsStatus>("server_tools_status", { sessionId });
}

/** Run a tool install command on the server (one-click); returns its output. */
export function runToolInstall(
  sessionId: string,
  command: string,
  sudoPassword?: string,
): Promise<string> {
  return invoke<string>("run_tool_install", { sessionId, command, sudoPassword });
}

/** Lint the editor buffer with a real tool on the server (Phase 12.7). */
export function lintRemote(
  sessionId: string,
  content: string,
  kind: string,
): Promise<RemoteLintResult> {
  return invoke<RemoteLintResult>("lint_remote", { sessionId, content, kind });
}

/** Content search under a remote directory (grep over SSH). */
export function sftpGrep(
  sessionId: string,
  dir: string,
  query: string,
  caseInsensitive: boolean,
  fixed: boolean,
): Promise<GrepMatch[]> {
  return invoke<GrepMatch[]>("sftp_grep", { sessionId, dir, query, caseInsensitive, fixed });
}

/** Apply a computed sync plan (uploads/downloads/deletes); returns counts. */
export function sftpSyncApply(
  sessionId: string,
  localRoot: string,
  remoteRoot: string,
  actions: SyncAction[],
): Promise<SyncStats> {
  return invoke<SyncStats>("sftp_sync_apply", { sessionId, localRoot, remoteRoot, actions });
}

/** Event name emitted when the OS asks vterm to open a file ("Open with vterm"). */
export const OPEN_FILE_EVENT = "vterm://open-file";

/**
 * Save editor text back to a remote file. `expectedSha256` is the hash the editor
 * opened with; a mismatch throws a `file-changed` error (see {@link isFileChangedError}).
 */
export function sftpWriteText(
  sessionId: string,
  path: string,
  content: string,
  eol: "lf" | "crlf",
  expectedSha256: string | null,
  opts: { sudo?: boolean; sudoPassword?: string; backup?: boolean } = {},
): Promise<WriteResult> {
  return invoke<WriteResult>("sftp_write_text", {
    sessionId,
    path,
    content,
    eol,
    expectedSha256,
    sudo: opts.sudo,
    sudoPassword: opts.sudoPassword,
    backup: opts.backup,
  });
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

/** Pick a single local file to open in the editor (palette "Open file…"). */
export async function pickOpenFile(): Promise<string | null> {
  const res = await open({ multiple: false, directory: false, title: "Open file" });
  return typeof res === "string" ? res : null;
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

// ── Session recording (Phase 11) ───────────────────────────────────────────────

/** Start recording a session to a new asciicast file; resolves to its path. */
export function startRecording(
  sessionId: string,
  title: string,
  cols: number,
  rows: number,
  prompt: string,
  env: string,
  maskPasswords: boolean,
  mode: string,
): Promise<string> {
  return invoke<string>("start_recording", {
    sessionId,
    title,
    cols,
    rows,
    prompt,
    env,
    maskPasswords,
    mode,
  });
}

/** Stop recording a session; resolves to the file path if one was active. */
export function stopRecording(sessionId: string): Promise<string | null> {
  return invoke<string | null>("stop_recording", { sessionId });
}

/** Pause or resume the active recording (tab switched away / idle). */
export function setRecordingPaused(sessionId: string, paused: boolean): Promise<void> {
  return invoke<void>("set_recording_paused", { sessionId, paused });
}

/** Write an audit annotation (e.g. an in-app config edit) into the recording. */
export function annotateRecording(sessionId: string, text: string): Promise<void> {
  return invoke<void>("annotate_recording", { sessionId, text });
}

/** List stored recordings, newest first. */
export function listRecordings(): Promise<RecordingMeta[]> {
  return invoke<RecordingMeta[]>("list_recordings");
}

/** Set a recording's title and description (rewrites its asciicast header). */
export function setRecordingMeta(path: string, title: string, description: string): Promise<void> {
  return invoke<void>("set_recording_meta", { path, title, description });
}

/** Delete a stored recording by path. */
export function deleteRecording(path: string): Promise<void> {
  return invoke<void>("delete_recording", { path });
}

/** Read a recording's raw asciicast content (for transcript export / player). */
export function readRecording(path: string): Promise<string> {
  return invoke<string>("read_recording", { path });
}

/** Write exported text (transcript or .cast copy) to a user-chosen path. */
export function exportRecording(path: string, content: string): Promise<void> {
  return invoke<void>("export_recording", { path, content });
}

/** Native "save as" dialog for an export; returns the chosen path or null. */
export function pickExportSavePath(defaultName: string): Promise<string | null> {
  return save({ defaultPath: defaultName });
}

/**
 * Import (upload) an external `.cast` recording into the library. The backend
 * validates it's an asciicast v2 file and copies it in; returns the new entry's
 * metadata. The player needs the full raw `.cast` stream, so only `.cast` files
 * (not transcripts) replay correctly.
 */
export function importRecording(srcPath: string): Promise<RecordingMeta> {
  return invoke<RecordingMeta>("import_recording", { srcPath });
}

/** Native open dialog for a `.cast` recording to upload; returns the path or null. */
export async function pickRecordingFile(): Promise<string | null> {
  const res = await open({
    multiple: false,
    directory: false,
    title: "Upload recording",
    filters: [{ name: "asciicast", extensions: ["cast"] }],
  });
  return typeof res === "string" ? res : null;
}
