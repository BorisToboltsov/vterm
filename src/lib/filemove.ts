// Pure helpers for drag-to-move within a file panel (SftpPanel/LocalFilePanel).
// Paths are '/'-separated: SFTP is always POSIX, and the local panel normalizes
// to '/' as well. Kept DOM-free so the move rules are unit-tested without a panel.
// Name-collision at the destination is enforced by the backend (it needs real
// filesystem access); here we only reject moves that are structurally invalid.

/** Strip trailing slashes, but keep a lone "/" (root) intact. */
function trimTrailing(path: string): string {
  return path === "/" ? "/" : path.replace(/\/+$/, "");
}

/** The parent directory: "/a/b" → "/a", "/a" → "/", "a" → "", "/" → "/". */
export function parentDir(path: string): string {
  const p = trimTrailing(path);
  const i = p.lastIndexOf("/");
  if (i < 0) return ""; // bare name, no parent
  if (i === 0) return "/"; // "/a" → "/"
  return p.slice(0, i);
}

/** The last path segment: "/a/b.txt" → "b.txt", "/a/" → "a". */
export function baseName(path: string): string {
  const p = trimTrailing(path);
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Join a directory and a name with exactly one separating slash. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

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
  if (dest.startsWith(`${src}/`)) return { ok: false, reason: "into-descendant" };
  if (dest === parentDir(src)) return { ok: false, reason: "noop" };
  return { ok: true, dest: joinPath(dest, baseName(src)) };
}
