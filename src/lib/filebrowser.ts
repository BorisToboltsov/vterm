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
import { baseName } from "./fspath";

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
  /** The files are on this machine (a local tab's panel), not on a server. */
  local?: boolean;
  /** Can files be created / renamed / deleted / dropped into `cwd`? (Drives level: no.) */
  mutable(cwd: string): boolean;
  /** Should navigating to `path` mirror into the terminal? (Drives level: no.) */
  mirrorsToTerminal(path: string): boolean;
  // ── Optional, SFTP-only. Presence gates the corresponding UI in <FileBrowser>. ──
  /** Pick local files and upload them into `destDir`. */
  upload?(destDir: string): Promise<void>;
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

// ── Upload onto taken names (v1.11.3) ────────────────────────────────────────
// A file dropped on the window replaced its namesake on the server without a
// question — and a drop is the gesture most easily made by accident. Now the
// folder is asked which names it holds, the user is asked once for the whole
// batch, and the backend refuses any upload onto an existing name that was not
// told it may replace (`dest-exists`), so a file that appeared in between is
// refused rather than lost.

/** An upload batch, split by whether the folder already holds that name. */
export interface UploadCheck {
  /** Local paths whose name is free in the folder. */
  fresh: string[];
  /** Local paths whose name the folder already holds. */
  clash: string[];
}

/**
 * Split `paths` (local) by the names `existing` (the remote folder's listing).
 * Remote names are POSIX: compared exactly, case and all.
 */
export function checkUpload(paths: string[], existing: Iterable<string>): UploadCheck {
  const taken = new Set(existing);
  const out: UploadCheck = { fresh: [], clash: [] };
  for (const p of paths) (taken.has(baseName(p)) ? out.clash : out.fresh).push(p);
  return out;
}

/** The user's answer about the taken names. */
export type ReplaceAnswer = "replace" | "skip" | "cancel";

/** One file of a batch, and whether it may replace what is there. */
export interface UploadItem {
  path: string;
  replace: boolean;
}

/**
 * What to upload once the question is answered, in the order the files were
 * given. `check` null — the folder could not be listed, so nothing is known:
 * only an explicit "replace" uploads, and then every file may replace. A name
 * believed free still goes without leave to replace: if it was taken meanwhile,
 * the backend refuses that one file.
 */
export function uploadItems(
  paths: string[],
  check: UploadCheck | null,
  answer: ReplaceAnswer,
): UploadItem[] {
  if (answer === "cancel") return [];
  if (check === null) {
    return answer === "replace" ? paths.map((path) => ({ path, replace: true })) : [];
  }
  const clash = new Set(check.clash);
  return paths
    .filter((path) => answer === "replace" || !clash.has(path))
    .map((path) => ({ path, replace: clash.has(path) }));
}

/** How many taken names the question lists before "…and N more". */
export const REPLACE_LIST_LIMIT = 5;

/**
 * The names to list in the question, and how many are left out. Each name once:
 * two files of a batch may share one (`a/x.txt` and `b/x.txt`).
 */
export function replaceList(
  clash: string[],
  limit = REPLACE_LIST_LIMIT,
): { names: string[]; more: number } {
  const names = [...new Set(clash.map(baseName))];
  return { names: names.slice(0, limit), more: Math.max(0, names.length - limit) };
}
