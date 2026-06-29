// `ls --color`-style classification for file listings (Phase 12 follow-up): pick
// a colour by type/permissions/extension, and format the `ls -l` permission string
// and owner. Colour is returned as a key into the active TerminalTheme so the panel
// resolves it to the user's terminal palette (matches what `ls` looks like in their
// shell). Pure + testable; the component maps the key to a CSS colour.

import type { TerminalTheme } from "./themes";
import { fileExt } from "./editorlang";

/** A colour slot in the terminal palette (bold/bright variants, like GNU ls). */
export type LsColorKey = keyof TerminalTheme;

interface EntryLike {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  mode: number | null;
  uid?: number | null;
  gid?: number | null;
  user?: string | null;
  group?: string | null;
}

const ARCHIVE = new Set([
  "tar", "gz", "tgz", "bz2", "xz", "zst", "zip", "7z", "rar", "lz", "lzma",
  "deb", "rpm", "jar", "war",
]);
const MEDIA = new Set([
  "jpg", "jpeg", "png", "gif", "svg", "webp", "bmp", "ico", "tiff", "avif",
  "mp3", "wav", "flac", "ogg", "mp4", "mkv", "avi", "mov", "webm",
]);

/** True when any execute bit is set. */
export function isExecutable(mode: number | null): boolean {
  return mode != null && (mode & 0o111) !== 0;
}

/**
 * The terminal-palette colour key for an entry, or `null` for a plain file
 * (default foreground). Mirrors GNU ls dircolors defaults: dir=blue, symlink=cyan,
 * executable=green, archive=red, image/media=magenta.
 */
export function lsColorKey(entry: EntryLike): LsColorKey | null {
  if (entry.isSymlink) return "brightCyan";
  if (entry.isDir) return "brightBlue";
  if (isExecutable(entry.mode)) return "brightGreen";
  const ext = fileExt(entry.name);
  if (ARCHIVE.has(ext)) return "brightRed";
  if (MEDIA.has(ext)) return "brightMagenta";
  return null;
}

function rwx(bits: number): string {
  return (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-");
}

/**
 * `ls -l`-style permission string, e.g. `drwxr-xr-x`. Includes the setuid/setgid
 * (`s`) and sticky (`t`) bits. Unknown mode → `?` placeholders.
 */
export function formatMode(mode: number | null, isDir: boolean, isSymlink: boolean): string {
  const type = isSymlink ? "l" : isDir ? "d" : "-";
  if (mode == null) return type + "?????????";
  let u = rwx((mode >> 6) & 7);
  let g = rwx((mode >> 3) & 7);
  let o = rwx(mode & 7);
  // setuid / setgid / sticky replace the execute slot (upper-case = no exec bit).
  if (mode & 0o4000) u = u.slice(0, 2) + (u[2] === "x" ? "s" : "S");
  if (mode & 0o2000) g = g.slice(0, 2) + (g[2] === "x" ? "s" : "S");
  if (mode & 0o1000) o = o.slice(0, 2) + (o[2] === "x" ? "t" : "T");
  return type + u + g + o;
}

/** `user:group`, falling back to numeric uid/gid (or `?` when unknown). */
export function ownerLabel(entry: EntryLike): string {
  const u = entry.user ?? (entry.uid != null ? String(entry.uid) : "?");
  const g = entry.group ?? (entry.gid != null ? String(entry.gid) : "?");
  return `${u}:${g}`;
}

/** Hover tooltip: permissions + owner (what `ls -l` shows). */
export function fileTooltip(entry: EntryLike): string {
  return `${formatMode(entry.mode, entry.isDir, entry.isSymlink)}  ${ownerLabel(entry)}`;
}
