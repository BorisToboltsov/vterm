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
}
