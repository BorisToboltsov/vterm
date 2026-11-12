// File operations: SFTP + local filesystem browsing, text read/write, transfers,
// directory sync, server-tools install, remote lint, grep, and file pickers.
import { call } from "./call";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { FileEntry, TextFile, WriteResult } from "../types";
import type { ShellUserReport } from "../files/fileuser";
import type { HashTree, SyncAction, SyncStats, GrepOutcome } from "../sync/sync";
import type { ToolsStatus } from "../editor/servertools";
import type { RemoteLintResult } from "../editor/remotelint";

// ── SFTP ──────────────────────────────────────────────────────────────────────

/** Who the terminal is now, and whom the file panel works as (ADR 0047). */
export function shellUser(sessionId: string): Promise<ShellUserReport> {
  return call<ShellUserReport>("shell_user", { sessionId });
}

/**
 * The file panel works as `user` from now on, through `sudo`. Throws with a marker
 * the panel reads (`fileUserFailure`): no password given, a wrong one, a refusal.
 */
export function sftpOpenAs(sessionId: string, user: string, password: string | null): Promise<void> {
  return call<void>("sftp_open_as", { sessionId, user, password });
}

/** The file panel works as the login user again. */
export function sftpOpenOwn(sessionId: string): Promise<void> {
  return call<void>("sftp_open_own", { sessionId });
}

export function sftpHome(sessionId: string): Promise<string> {
  return call<string>("sftp_home", { sessionId });
}

export function sftpList(sessionId: string, path: string): Promise<FileEntry[]> {
  return call<FileEntry[]>("sftp_list", { sessionId, path });
}

export function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return call<void>("sftp_mkdir", { sessionId, path });
}

export function sftpCreateFile(sessionId: string, path: string): Promise<void> {
  return call<void>("sftp_create_file", { sessionId, path });
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
  return call<TextFile>("sftp_read_text", { sessionId, path, maxBytes, sudo, sudoPassword });
}

/** Advisory check for the editor's temp-sibling save directory. */
export function sftpWriteAccess(
  sessionId: string,
  path: string,
): Promise<"writable" | "restricted" | "unknown"> {
  return call("sftp_write_access", { sessionId, path });
}

/** Check sudo authentication before editing; later write permission can still differ. */
export function sftpCheckSudo(sessionId: string, password: string): Promise<boolean> {
  return call("sftp_check_sudo", { sessionId, password });
}

/** Open a LOCAL file as text in the editor (throws on large/binary files). */
export function readLocalText(path: string, maxBytes?: number): Promise<TextFile> {
  return call<TextFile>("read_local_text", { path, maxBytes });
}

/**
 * Read a remote file as base64 bytes — the markdown preview's inline images
 * (Phase 44.4). The backend clamps `maxBytes` to a small ceiling of its own, so
 * this can never become a back door around the SFTP panel's download.
 */
export function sftpReadBytes(
  sessionId: string,
  path: string,
  maxBytes?: number,
): Promise<string> {
  return call<string>("sftp_read_bytes", { sessionId, path, maxBytes });
}

/** Read a LOCAL file as base64 bytes (local half of `sftpReadBytes`). */
export function readLocalBytes(path: string, maxBytes?: number): Promise<string> {
  return call<string>("read_local_bytes", { path, maxBytes });
}

/**
 * Save editor text back to a LOCAL file (atomic, conflict-checked). `encoding` is
 * the label the read reported; omitting it means UTF-8. Pass it back so a Windows
 * UTF-16 or CP1251 config is rewritten in its own encoding, not converted.
 */
export function writeLocalText(
  path: string,
  content: string,
  eol: "lf" | "crlf",
  expectedSha256: string | null,
  encoding?: string,
): Promise<WriteResult> {
  return call<WriteResult>("write_local_text", {
    path,
    content,
    eol,
    encoding,
    expectedSha256,
  });
}

/** Export the current buffer as a new local file, preserving its EOL and encoding. */
export function saveEditorCopy(
  path: string,
  content: string,
  eol: "lf" | "crlf",
  encoding: string,
): Promise<void> {
  return call("save_editor_copy", { path, content, eol, encoding });
}

/** Drain the queue of files vterm was asked to open (CLI args / macOS Opened). */
export function takePendingOpens(): Promise<string[]> {
  return call<string[]>("take_pending_opens");
}

// ── Local filesystem browser (right panel for local-terminal tabs) ──────────────

export function localHome(): Promise<string> {
  return call<string>("local_home");
}

export function localList(path: string): Promise<FileEntry[]> {
  return call<FileEntry[]>("local_list", { path });
}

/** Which of `paths` are folders (files dropped on the window name only their paths). */
export function localKinds(paths: string[]): Promise<boolean[]> {
  return call<boolean[]>("local_kinds", { paths });
}

/**
 * The working directory of a LOCAL shell, read from the OS (Phase 39.3) — the
 * shell-independent half of "follow the terminal". Null when the session is
 * unknown or the OS declined to say; callers leave the panel where it is rather
 * than guessing. SSH tabs have no local pid and still rely on OSC 7 / OSC 9;9.
 */
export function localCwd(sessionId: string): Promise<string | null> {
  return call<string | null>("local_cwd", { sessionId });
}

/**
 * Start or stop noting the folder each line typed into a LOCAL shell runs in
 * (v1.24) — while the tab's terminal shows file links. False when the session
 * does not exist (yet).
 */
export function watchLocalSubmits(sessionId: string, on: boolean): Promise<boolean> {
  return call<boolean>("watch_local_submits", { sessionId, on });
}

/**
 * The folder the last line typed into a LOCAL shell ran in, noted as it was
 * sent. Null when the shell was running a program then (`ssh`, a REPL) — the
 * line was that program's, not the shell's — or the OS would not say.
 */
export function localSubmittedCwd(sessionId: string): Promise<string | null> {
  return call<string | null>("local_submitted_cwd", { sessionId });
}

export function localMkdir(path: string): Promise<void> {
  return call<void>("local_mkdir", { path });
}

export function localCreateFile(path: string): Promise<void> {
  return call<void>("local_create_file", { path });
}

export function localDelete(path: string, isDir: boolean): Promise<void> {
  return call<void>("local_delete", { path, isDir });
}

/** Move a local file/folder to `to` (drag-to-move). Rejects if `to` exists. */
export function localRename(from: string, to: string): Promise<void> {
  return call<void>("local_rename", { from, to });
}

/** Copy a local file/folder (recursively) to `to`. Rejects if `to` exists. */
export function localCopy(from: string, to: string): Promise<void> {
  return call<void>("local_copy", { from, to });
}

// ── Directory sync (Phase 12.5) ─────────────────────────────────────────────────

/**
 * Hash a remote directory tree via sha256sum over SSH (no download). `cancelId`
 * registers the run in the shared cancel map: `sftpCancel(cancelId)` stops it.
 */
export function sftpHashTree(
  sessionId: string,
  path: string,
  excludes: string[],
  cancelId: string,
): Promise<HashTree> {
  return call<HashTree>("sftp_hash_tree", { sessionId, path, excludes, cancelId });
}

/**
 * Hash a local directory tree; `sftpCancel(cancelId)` stops the walk. `excludes`
 * lets the backend prune what it safely can (see `sync::ExcludeSet`) — the result
 * is still filtered by `diffTrees`. Both sides report counts on `sync://scan`.
 */
export function localHashTree(path: string, excludes: string[], cancelId: string): Promise<HashTree> {
  return call<HashTree>("local_hash_tree", { path, excludes, cancelId });
}

/** Detect the server's package manager + which optional tools are installed. */
export function serverToolsStatus(sessionId: string): Promise<ToolsStatus> {
  return call<ToolsStatus>("server_tools_status", { sessionId });
}

/** Run a tool install command on the server (one-click); returns its output. */
export function runToolInstall(
  sessionId: string,
  command: string,
  sudoPassword?: string,
): Promise<string> {
  return call<string>("run_tool_install", { sessionId, command, sudoPassword });
}

/**
 * Lint the editor buffer with a real tool on the server (Phase 12.7). `name` is the
 * file's basename — some validators infer the type from it (systemd-analyze needs the
 * unit suffix). `sudoPassword` (reused from an open-as-root, never a fresh prompt) runs
 * validators that require root (`sshd -t`) under sudo.
 */
export function lintRemote(
  sessionId: string,
  content: string,
  kind: string,
  opts: { name?: string; sudoPassword?: string } = {},
): Promise<RemoteLintResult> {
  return call<RemoteLintResult>("lint_remote", {
    sessionId,
    content,
    kind,
    name: opts.name,
    sudoPassword: opts.sudoPassword,
  });
}

/** List every config file nginx loads on the server (`nginx -T`), for detecting
 *  nginx configs outside the `/etc/nginx/` tree. Empty when nginx is absent/unreadable.
 *  `sudoPassword` (reused from an open-as-root, never a fresh prompt) runs the dump under
 *  sudo so a root-only config tree still resolves. */
export function nginxConfigFiles(sessionId: string, sudoPassword?: string): Promise<string[]> {
  return call<string[]>("nginx_config_files", { sessionId, sudoPassword });
}

/** Content search under a remote directory (grep over SSH). */
export function sftpGrep(
  sessionId: string,
  dir: string,
  query: string,
  caseInsensitive: boolean,
  fixed: boolean,
  /** How many matches to return; absent — one page (`GREP_LIMIT`). The backend holds it within `GREP_MAX`. */
  limit?: number,
): Promise<GrepOutcome> {
  return call<GrepOutcome>("sftp_grep", { sessionId, dir, query, caseInsensitive, fixed, limit: limit ?? null });
}

/**
 * Start applying a computed sync plan (uploads/downloads/deletes) — resolves
 * once it has started (v1.36, ADR 0058). The run is the backend's: how it goes
 * and how it ends is told (`SYNC_RUN_EVENT`) to whichever window shows the
 * session's tab at the moment. `runId` is the handle `sftpCancel` stops it
 * with — the same cancel map folder downloads use.
 */
export function sftpSyncStart(
  sessionId: string,
  runId: string,
  localRoot: string,
  remoteRoot: string,
  actions: SyncAction[],
): Promise<void> {
  return call<void>("sftp_sync_start", {
    sessionId,
    runId,
    localRoot,
    remoteRoot,
    actions,
  });
}

/** How a sync run stands, told to the window that shows its session. */
export const SYNC_RUN_EVENT = "sync://run";

/** A sync run as the backend tells it (`sync.rs` `RunView`). */
export interface SyncRunView {
  runId: string;
  sessionId: string;
  state: "running" | "done" | "stopped" | "failed";
  stats: SyncStats;
  error: string | null;
}

/** The last sync run of a session — asked by a window that has just taken its tab over. */
export function syncRunOf(sessionId: string): Promise<SyncRunView | null> {
  return call<SyncRunView | null>("sync_run_of", { sessionId });
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
  opts: {
    sudo?: boolean;
    sudoPassword?: string;
    backup?: boolean;
    /** Encoding the read reported; omitted means UTF-8. See textenc.rs. */
    encoding?: string;
  } = {},
): Promise<WriteResult> {
  return call<WriteResult>("sftp_write_text", {
    sessionId,
    path,
    content,
    eol,
    encoding: opts.encoding,
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
  return call<void>("sftp_delete", { sessionId, path, isDir });
}

/** Move a remote file/folder to `to` (drag-to-move). Rejects if `to` exists. */
export function sftpRename(sessionId: string, from: string, to: string): Promise<void> {
  return call<void>("sftp_rename", { sessionId, from, to });
}

/** Copy a remote file/folder (recursively) to `to`. Rejects if `to` exists. */
export function sftpCopy(sessionId: string, from: string, to: string): Promise<void> {
  return call<void>("sftp_copy", { sessionId, from, to });
}

// ── Transfers the backend owns (v1.12, ADR 0025) ────────────────────────────
// An upload, a download, a copy between two sessions or a local copy is a *job*:
// started by one call that returns at once, carried out by the backend, and
// reported in `sftp://job` to whichever window shows the tab of each session it
// touches. A window awaits none of them (see `transfers.rs`).

/** One side of a transfer. */
export interface TransferSide {
  /** The tab this side belongs to, or null — a path named outside any tab. */
  session: string | null;
  /** The files are on this machine, not on the session's server. */
  local: boolean;
  /** What the user calls that tab (shown, and written to the other side's recording). */
  label: string;
}

/** One file or folder to move. */
export interface TransferItem {
  from: string;
  /** Where it lands — the full path, name included. */
  to: string;
  isDir: boolean;
  /** What is already at `to` may go; without it the backend refuses (`dest-exists`). */
  replace: boolean;
}

export interface TransferSpec {
  id: string;
  src: TransferSide;
  dst: TransferSide;
  items: TransferItem[];
  /** The folder the items land in — a panel showing it re-lists when the job ends. */
  destDir: string;
}

/** `queued` (v1.35) — waiting for an earlier job of one of its sessions to end. */
/** `interrupted` — cut off by its session ending under it (v1.36, ADR 0060); `cancelled` — stopped by the user. */
export type TransferState = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

/** A job as the backend reports it. */
export interface TransferJob {
  id: string;
  src: TransferSide;
  dst: TransferSide;
  destDir: string;
  /** The file being moved now. */
  name: string;
  /** Files finished, of `fileCount` (0 of 0 while the tree is walked). */
  fileIndex: number;
  fileCount: number;
  /** Bytes moved, of `total`, across the whole job. */
  transferred: number;
  total: number;
  state: TransferState;
  /** The first thing that went wrong. */
  error: string | null;
  /** Files and folders that did not make it. */
  failed: number;
  /** Unreadable sub-folders, and links the destination cannot hold (Windows) or the source would not read, left out (v1.34: links go over as links). */
  skipped: number;
  /** It ended with something left to do and is kept to go on with (v1.36, ADR 0060). */
  resumable: boolean;
}

/** Start a transfer; resolves with its id as soon as the backend has taken it. */
export function transferStart(spec: TransferSpec): Promise<string> {
  return call<string>("transfer_start", { spec });
}

/** The transfers this window shows right now (asked on start and on taking a tab over). */
export function transferList(): Promise<TransferJob[]> {
  return call<TransferJob[]>("transfer_list");
}

/**
 * Go on with an interrupted transfer (v1.36, ADR 0060): a job again, under the
 * same id, copying what was left — the cut-off file from its last checkpoint.
 * Refused while a session of it is not connected; the job stays kept.
 */
export function transferResume(id: string): Promise<void> {
  return call<void>("transfer_resume", { id });
}

/** Drop an interrupted transfer and its partial copies. */
export function transferForget(id: string): Promise<void> {
  return call<void>("transfer_forget", { id });
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

/** Progress of one file of a sync run (`sftp://progress`). */
export interface SftpProgress {
  id: string;
  name: string;
  direction: "upload" | "download";
  transferred: number;
  total: number;
  done: boolean;
}

/** Stop a transfer, a sync run or a tree hash by its id. */
export function sftpCancel(transferId: string): Promise<void> {
  return call<void>("sftp_cancel", { transferId });
}
