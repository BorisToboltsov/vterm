// Pure helpers for drag-to-move within a file panel (SftpPanel/LocalFilePanel).
// Kept DOM-free so the move rules are unit-tested without a panel. Name-collision
// at the destination is enforced by the backend (it needs real filesystem access);
// here we only reject moves that are structurally invalid.
//
// Path arithmetic itself lives in fspath.ts (Phase 39) so it is separator-aware:
// SFTP is always POSIX, but the local panel gets native paths, and on Windows the
// old '/'-only rules silently failed — a folder dragged into its own subtree was
// accepted because `C:\a\b` never matched the `C:\a` + '/' descendant test.

import { baseName, isUnder, joinPath, parentOf, trimTrailing } from "./fspath";

export { baseName, joinPath, parentOf as parentDir } from "./fspath";

/** Split a file name into base + extension ("a.tar.gz" → "a.tar" + ".gz"). A
 *  leading dot (dotfiles like ".bashrc") is treated as part of the base. */
function splitExt(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf(".");
  return i > 0 ? { base: name.slice(0, i), ext: name.slice(i) } : { base: name, ext: "" };
}

const COPY_SUFFIX = / copy( \d+)?$/;

/**
 * A free "… copy" name for duplicating `name` into a folder that already holds
 * `existing` names (Finder-style): "report.txt" → "report copy.txt" →
 * "report copy 2.txt". An existing " copy"/" copy N" suffix is normalized so
 * duplicating a copy keeps numbering the original stem rather than nesting.
 */
export function uniqueCopyName(name: string, existing: Set<string>): string {
  const { base, ext } = splitExt(name);
  const root = base.replace(COPY_SUFFIX, "");
  const first = `${root} copy${ext}`;
  if (!existing.has(first)) return first;
  let n = 2;
  while (existing.has(`${root} copy ${n}${ext}`)) n += 1;
  return `${root} copy ${n}${ext}`;
}

export type MoveCheck =
  | { ok: true; dest: string }
  | { ok: false; reason: "noop" | "self" | "into-descendant" };

/**
 * Validate moving `srcPath` (a file or folder) into directory `destDir`, and
 * compute the resulting destination path.
 * - `self`: dropping an item onto itself.
 * - `into-descendant`: moving a folder into its own subtree.
 * - `noop`: the item already lives directly in `destDir`.
 * On success, `dest` = `destDir`/`baseName(srcPath)`.
 */
export function checkMove(srcPath: string, destDir: string): MoveCheck {
  const src = trimTrailing(srcPath);
  const dest = trimTrailing(destDir);
  if (dest === src) return { ok: false, reason: "self" };
  if (isUnder(dest, src)) return { ok: false, reason: "into-descendant" };
  if (dest === parentOf(src)) return { ok: false, reason: "noop" };
  return { ok: true, dest: joinPath(dest, baseName(src)) };
}
