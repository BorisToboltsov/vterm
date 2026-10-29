// The order of a file listing (v1.17). A listing came sorted one way — folders
// first, then by name — because the backend sorted it; the table shows size,
// permissions, owner and time in columns, and a table is sorted by its columns.
// Pure: what the orders are, what a click on a column title asks for, and the
// sort itself. The choice is kept by `stores/filesort.svelte.ts`.
//
// Three rules hold in every order:
//  - folders stay above files. The key orders each group within itself; a
//    folder has no size, so by size folders go by name;
//  - a value the listing did not report goes last, whichever way the order
//    runs: an unknown time is not the oldest time, nor the newest;
//  - equal values fall back to the name, so the order is total — the same
//    listing never comes out two ways.

import type { MenuItem } from "../ui/ctxmenu";
import { ownerLabel } from "./lscolors";
import type { FileEntry } from "../types";

/** The columns a listing can be ordered by. */
export const SORT_KEYS = ["name", "size", "mode", "owner", "modified"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export interface FileSort {
  key: SortKey;
  dir: SortDir;
}

/** The order a listing has always had. */
export const DEFAULT_SORT: FileSort = { key: "name", dir: "asc" };

/**
 * The direction a column starts with: text reads A→Z, but the question asked of
 * a size or a time is "which is the biggest", "which is the latest".
 */
export function firstDir(key: SortKey): SortDir {
  return key === "size" || key === "modified" ? "desc" : "asc";
}

/** What a click on a column title asks for: that column, or the other way round. */
export function nextSort(current: FileSort, key: SortKey): FileSort {
  if (current.key !== key) return { key, dir: firstDir(key) };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

export const isSortKey = (v: unknown): v is SortKey =>
  typeof v === "string" && (SORT_KEYS as readonly string[]).includes(v);

/** The stored choice (`vterm.filesort`) made safe to use; anything else is the default. */
export function sanitizeSort(raw: unknown): FileSort {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SORT };
  const { key, dir } = raw as { key?: unknown; dir?: unknown };
  if (!isSortKey(key)) return { ...DEFAULT_SORT };
  return { key, dir: dir === "desc" ? "desc" : dir === "asc" ? "asc" : firstDir(key) };
}

export const sameSort = (a: FileSort, b: FileSort): boolean => a.key === b.key && a.dir === b.dir;

/** Names compare as the backend compares them: case-insensitively. */
const byName = (a: FileEntry, b: FileEntry): number => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/** The value an entry is ordered by, or null when the listing did not report one. */
function valueOf(entry: FileEntry, key: Exclude<SortKey, "name">): number | string | null {
  switch (key) {
    case "size":
      // A folder's "size" is the size of its directory entry, not of what is in it.
      return entry.isDir ? null : entry.size;
    case "modified":
      return entry.modified;
    case "mode":
      // Windows has no permission bits: its attribute string orders the column.
      return entry.mode ?? entry.attrs ?? null;
    case "owner": {
      const owner = ownerLabel(entry);
      return owner === "" || owner === "?:?" ? null : owner.toLowerCase();
    }
  }
}

/**
 * `entries` in the order `sort` asks for — a new array; folders first, unknown
 * values last, ties by name.
 */
export function sortEntries(entries: readonly FileEntry[], sort: FileSort): FileEntry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const key = sort.key;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (key === "name") return sign * byName(a, b);
    const x = valueOf(a, key);
    const y = valueOf(b, key);
    if (x === null || y === null) {
      if (x === null && y === null) return byName(a, b);
      return x === null ? 1 : -1;
    }
    if (x !== y) {
      // A number against a string (permission bits against an attribute string)
      // cannot be told apart by value: keep them grouped, numbers first.
      if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
      return sign * (x < y ? -1 : 1);
    }
    return byName(a, b);
  });
}

/**
 * The order as a menu — for a listing too narrow to have column titles to
 * click: the columns as switches, then the two directions. Picking another
 * column starts it in its own first direction, as a click on its title would.
 */
export function sortMenu(
  sort: FileSort,
  labels: { key: (key: SortKey) => string; dir: (dir: SortDir) => string },
  onpick: (next: FileSort) => void,
): MenuItem[] {
  return [
    ...SORT_KEYS.map(
      (key): MenuItem => ({
        checked: sort.key === key,
        label: labels.key(key),
        onSelect: () => onpick(sort.key === key ? sort : { key, dir: firstDir(key) }),
      }),
    ),
    { kind: "separator" },
    ...(["asc", "desc"] as const).map(
      (dir): MenuItem => ({
        checked: sort.dir === dir,
        label: labels.dir(dir),
        onSelect: () => onpick({ key: sort.key, dir }),
      }),
    ),
  ];
}
