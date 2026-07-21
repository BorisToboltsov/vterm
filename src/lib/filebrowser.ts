// Shared core of the two file-browser panels (Phase 44.8). SftpPanel and
// LocalFilePanel were near-identical copies — ~530 lines of the same selection,
// keyboard, clipboard, drag-move, path-edit and virtualization logic, down to
// byte-identical function bodies and shared `t("sftp.*")` keys. The duplication
// was a standing hazard: a fix to one panel had to be remembered for the other,
// exactly the class of bug the fspath.ts consolidation (Phase 39) called out.
//
// The two panels are unified into <FileBrowser>, parameterized by this adapter.
// The adapter carries BOTH the transport (SSH SFTP vs local FS) AND the two
// navigation-semantics that genuinely differ:
//   * what "up" means — POSIX parent for SFTP, but on local Windows the synthetic
//     "This PC" drives level sits above a drive root (fspath.navParent);
//   * whether the current directory is mutable — the drives level is synthetic and
//     nothing there can be created/renamed/deleted/dropped-into.
// Everything else is shared, so it lives in <FileBrowser> once, and the pure bits
// that can be tested without a DOM live here.

import type { FileEntry } from "./types";
import type { GrepMatch } from "./sync";
import { uniqueCopyName } from "./filemove";

/** One rendered row of the virtualized list: either the ".." nav or a real entry. */
export interface VisibleItem {
  key: string;
  entry: FileEntry | null;
}

/**
 * Transport + navigation semantics for one browser kind. The transport methods
 * are the parallel SFTP/local commands; the navigation predicates capture the two
 * places where the two kinds legitimately diverge (see module header).
 */
export interface FileBrowserAdapter {
  list(path: string): Promise<FileEntry[]>;
  mkdir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  remove(path: string, isDir: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** Resolve the home directory (SFTP: remote `~`; local: OS home). */
  home(): Promise<string>;
  /** Is there a level above `cwd` to navigate to (the ".." row)? */
  hasParent(cwd: string): boolean;
  /** The directory ".." leads to, or null when already at the top. */
  parentForUp(cwd: string): string | null;
  /** Can files be created / renamed / deleted / dropped into `cwd`? (Drives level: no.) */
  mutable(cwd: string): boolean;
  /** Should navigating to `path` mirror into the terminal? (Drives level: no.) */
  mirrorsToTerminal(path: string): boolean;
  // ── Optional, SFTP-only. Presence gates the corresponding UI in <FileBrowser>. ──
  /** Pick local files and upload them into `destDir`. */
  upload?(destDir: string): Promise<void>;
  /** Upload OS-dropped paths into `destDir`. */
  uploadPaths?(destDir: string, paths: string[]): Promise<void>;
  /** Download a file/dir to a user-picked destination. */
  download?(entry: FileEntry): Promise<void>;
  /** Content search (grep) under `cwd`. */
  search?(cwd: string, query: string, caseInsensitive: boolean, fixedString: boolean): Promise<GrepMatch[]>;
}

/**
 * The window of rows to render for the virtual list. Item 0 is the ".." nav when
 * `hasParent`; the rest index into `shownEntries` offset by that row. Pulled out of
 * both panels' identical `visibleItems` derived so the off-by-one (the `..` offset)
 * is defined and tested in exactly one place.
 */
export function buildVisibleItems(
  winStart: number,
  winEnd: number,
  hasParent: boolean,
  shownEntries: readonly FileEntry[],
): VisibleItem[] {
  const items: VisibleItem[] = [];
  for (let i = winStart; i < winEnd; i++) {
    if (hasParent && i === 0) items.push({ key: "..", entry: null });
    else {
      const e = shownEntries[i - (hasParent ? 1 : 0)];
      if (e) items.push({ key: e.path, entry: e });
    }
  }
  return items;
}

/**
 * Where to put the roving cursor after going up a level: on the folder we just
 * came out of (so arrow keys continue from there), accounting for the ".." row,
 * or the first row / nothing when that folder is hidden or the dir is empty.
 * `rowCount` includes the ".." row. Identical in both panels' `goUp`.
 */
export function cursorForReturnedFolder(
  shownEntries: readonly FileEntry[],
  fromPath: string,
  hasParent: boolean,
  rowCount: number,
): number {
  const idx = shownEntries.findIndex((e) => e.path === fromPath);
  return idx >= 0 ? (hasParent ? idx + 1 : idx) : rowCount ? 0 : -1;
}

/**
 * The name a pasted item takes in the destination. Copying onto an existing name
 * duplicates it Finder-style ("… copy"); moving (cut) keeps the name and lets the
 * backend refuse to clobber. `taken` is the set of names already in the dest dir.
 */
export function pasteTargetName(
  mode: "copy" | "cut",
  name: string,
  taken: Set<string>,
): string {
  return mode === "copy" && taken.has(name) ? uniqueCopyName(name, taken) : name;
}

/**
 * Does a backend error mean "the destination already exists" (a skip, not a
 * hard failure)? The marker travels in the typed AppError's Display string
 * (error.rs). Both panels tested this inline with `.includes`; centralized so the
 * marker string lives in one place.
 */
export function isDestExists(errorMessage: string): boolean {
  return errorMessage.includes("dest-exists");
}
