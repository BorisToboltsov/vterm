// Cross-cutting API helpers: typed-error predicates, native clipboard read,
// and the native-menu command. Split from api.ts in Phase 18.6.
import { invoke } from "@tauri-apps/api/core";

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
