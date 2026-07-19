// Cross-cutting API helpers: typed-error predicates, native clipboard read,
// and the native-menu command. Split from api.ts in Phase 18.6.
import { invoke } from "@tauri-apps/api/core";
import type { GenerateKeyRequest } from "../sshkeygen";

/** Marker (in `AppError::FileChangedOnServer`) that a save lost a race. */
export const FILE_CHANGED_MARKER = "file-changed";

/** True when a thrown invoke error means the file changed on the server. */
export function isFileChangedError(err: unknown): boolean {
  return String(err).includes(FILE_CHANGED_MARKER);
}

/** Marker (in `AppError::BackupFailed`) that the pre-save `.bak` copy failed. */
export const BACKUP_FAILED_MARKER = "backup-failed";

/**
 * True when a save was abandoned because the requested `.bak` copy could not be
 * made. Crucially this means **nothing was written** — the target still holds its
 * original content — so the message must say so rather than read as a save error.
 */
export function isBackupFailedError(err: unknown): boolean {
  return String(err).includes(BACKUP_FAILED_MARKER);
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

/**
 * Read clipboard text in the Rust process (macOS NSPasteboard). Bypasses
 * WKWebView so `navigator.clipboard.readText()`'s "Paste" prompt never appears.
 * Rejects on platforms without a native reader so the caller can fall back.
 */
export function readClipboardText(): Promise<string> {
  return invoke<string>("read_clipboard_text");
}

// ── Host environment ────────────────────────────────────────────────────────

/**
 * The host OS the app runs on ("windows"/"macos"/"linux"/…), from the Rust
 * backend (`std::env::consts::OS`). Lets the UI gate OS-specific settings — e.g.
 * the Windows local-shell picker — without a runtime OS plugin in the WebView.
 */
export function hostOs(): Promise<string> {
  return invoke<string>("host_os");
}

/**
 * Whether `program` resolves to an executable (an explicit path checked as-is, a
 * bare name searched on PATH). Used to gray out pwsh when it isn't installed and
 * to validate a custom local-shell path.
 */
export function shellExists(program: string): Promise<boolean> {
  return invoke<boolean>("shell_exists", { program });
}

// ── SSH key generation utility (Phase 32) ──────────────────────────────────────

/** Marker (in `AppError::KeyExists`) that a key file already exists at the path. */
export const KEY_EXISTS_MARKER = "key-exists";

/** True when a generate call was refused because a file already exists there. */
export function isKeyExistsError(err: unknown): boolean {
  return String(err).includes(KEY_EXISTS_MARKER);
}

/** A generated OpenSSH key pair (mirrors `keygen::GeneratedKey`). */
export interface GeneratedKey {
  path: string;
  publicKeyPath: string;
  /** OpenSSH public-key line, for copying into `authorized_keys`. */
  publicKey: string;
  /** SHA-256 fingerprint (`SHA256:…`). */
  fingerprint: string;
}

/**
 * Generate an OpenSSH key pair locally (no network) and write it to disk. Throws
 * an `AppError::KeyExists` (see {@link isKeyExistsError}) when the target exists
 * and `req.overwrite` is false.
 */
export function generateSshKey(req: GenerateKeyRequest): Promise<GeneratedKey> {
  return invoke<GeneratedKey>("generate_ssh_key", { req });
}

/** Whether a key file already exists at `path` (`~` expanded) — live collision hint. */
export function keyPathExists(path: string): Promise<boolean> {
  return invoke<boolean>("key_path_exists", { path });
}

/** (Re)write the public key to `<path>.pub`; resolves to that path. */
export function savePublicKey(path: string, publicKey: string): Promise<string> {
  return invoke<string>("save_public_key", { path, publicKey });
}

// ── known_hosts manager (Phase 33) ──────────────────────────────────────────────

/** One recorded host key (mirrors `KnownHostEntry` in Rust). */
export interface KnownHostEntry {
  /** `host:port` identifier. */
  id: string;
  /** Recorded SHA256 host-key fingerprint. */
  fingerprint: string;
}

/** List every vterm-recorded host key (local file read only). */
export function listKnownHosts(): Promise<KnownHostEntry[]> {
  return invoke<KnownHostEntry[]>("list_known_hosts");
}

/** Forget the recorded host key for `id`; resolves to whether one was removed. */
export function removeKnownHost(id: string): Promise<boolean> {
  return invoke<boolean>("remove_known_host", { id });
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
