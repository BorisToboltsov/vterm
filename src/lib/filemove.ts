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
