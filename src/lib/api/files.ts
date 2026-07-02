// File operations: SFTP + local filesystem browsing, text read/write, transfers,
// directory sync, server-tools install, remote lint, grep, and file pickers.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { FileEntry, TextFile, WriteResult } from "../types";
import type { HashEntry, SyncAction, SyncStats, GrepMatch } from "../sync";
import type { ToolsStatus } from "../servertools";
import type { RemoteLintResult } from "../remotelint";

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
