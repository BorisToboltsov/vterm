// Shared types mirroring the Rust backend models (src-tauri/src/model.rs).

import type { AiExecMode } from "./ai";

export type AuthMethod = "password" | "key";

/** Kind of proxy a server connects through. Only "jump" (an SSH bastion) is
 *  implemented; "socks5"/"http" are reserved — selecting them errors at connect
 *  time until those transports land (mirrors ProxyKind in model.rs). */
export type ProxyKind = "jump" | "socks5" | "http";

/** A proxy/jump host a server tunnels through (mirrors ServerProxy in model.rs).
 *  Secrets are never stored here — the jump host's password/passphrase live in
 *  the keychain under a proxy-scoped id; `hasSavedPassword` is a UI hint. */
export interface ServerProxy {
  kind: ProxyKind;
  host: string;
  port: number;
  /** Login on the jump host (SSH jump kind). */
  username: string;
  /** Auth method for the jump host (SSH jump kind). */
  authMethod: AuthMethod;
  /** Path to the jump host's private key (used when authMethod === "key"). */
  keyPath: string | null;
  /** Whether a proxy secret is stored in the OS keychain. */
  hasSavedPassword: boolean;
}

export interface ServerProfile {
  id: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** Path to a private key file (used when authMethod === "key"). */
  keyPath: string | null;
  /** Whether a password is stored for this profile in the OS keychain. */
  hasSavedPassword: boolean;
  /** Optional group/folder for organizing the server list. */
  group: string | null;
  /** Free-form tags for filtering/search. */
  tags: string[];
  /** Auto-start recording whenever a session to this server connects. */
  autoRecord: boolean;
  /** Mark off-limits to the AI assistant (blocks context/execution/auto). */
  noAi: boolean;
  /** Chat prompt id used on this server (from settings.ai.prompts.chat), or null. */
  chatPromptId: string | null;
  /** Per-server command-execution mode override, or null to use the global one. */
  execMode: AiExecMode | null;
  /** Proxy/jump host this server connects through, or null for a direct connection. */
  proxy: ServerProxy | null;
  /** Free-form user notes (Markdown) about this server. Edited in the notes
   *  window (not the server form); saved via the dedicated `setServerNotes`. */
  notes: string;
  /** Pictogram key shown before the alias (see servericons.ts); "" = generic. */
  icon: string;
  /** Colour key tinting the pictogram (see servericons.ts); "" = muted. */
  iconColor: string;
}

/** A remote file/directory entry from SFTP (mirrors sftp.rs FileEntry). */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  /** Modification time, epoch seconds. */
  modified: number | null;
  /** Unix permission bits (the entry's own), if reported. */
  mode: number | null;
  /** Owner user/group ids. */
  uid: number | null;
  gid: number | null;
  /** Resolved owner names (or null → frontend shows the numeric id). */
  user: string | null;
  group: string | null;
}

/** A remote text file opened in the editor (mirrors sftp.rs TextFile). */
export interface TextFile {
  content: string;
  /** Original line-ending style, re-applied on save. */
  eol: "lf" | "crlf";
  size: number;
  /** Unix permission bits, if reported. */
  mode: number | null;
  /** Modification time, epoch seconds. */
  mtime: number | null;
  /** SHA-256 of the on-server bytes when opened (passed back for conflict check). */
  sha256: string;
  /** Best-effort hint that the file has no write bit set. */
  readOnly: boolean;
}

/** Fresh metadata returned after a successful save (mirrors sftp.rs WriteResult). */
export interface WriteResult {
  sha256: string;
  size: number;
  mtime: number | null;
}

/** Payload for creating/updating a server profile. Backend assigns the id. */
export interface NewServerProfile {
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath: string | null;
  group: string | null;
  tags: string[];
  autoRecord: boolean;
  noAi: boolean;
  chatPromptId: string | null;
  execMode: AiExecMode | null;
  proxy: ServerProxy | null;
  icon: string;
  iconColor: string;
}

/** Metadata about a stored session recording (from its asciicast header). */
export interface RecordingMeta {
  path: string;
  title: string;
  /** Free-form description set by the user when saving the recording. */
  description: string;
  /** Server/host the session was recorded on (preserved across title renames). */
  server: string;
  width: number;
  height: number;
  /** Recording start time, epoch seconds. */
  timestamp: number;
  /** File size in bytes. */
  size: number;
}
