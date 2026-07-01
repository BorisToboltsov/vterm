// Shared types mirroring the Rust backend models (src-tauri/src/model.rs).

export type AuthMethod = "password" | "key";

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
