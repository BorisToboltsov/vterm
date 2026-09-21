// Remote-folder tree for the sync dialog's picker (v1.0.25). Pure: which rows are
// visible, which ancestors to open for a starting path, and what a key does. The
// component only loads children over `sftpList` and draws these rows. SFTP paths
// are always POSIX, so this module is too.

import { parentOf } from "./fspath";

export interface TreeDir {
  name: string;
  path: string;
}

/** A folder's children: listed, being listed, or the listing failed. */
export type TreeChildren = Record<string, TreeDir[] | "loading" | { error: string }>;

export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  /** Children were listed and there are none — no chevron to offer. */
  leaf: boolean;
  loading: boolean;
  error: string | null;
}

/** The root itself, then every folder down to `path`: `/srv/app` → `/`, `/srv`, `/srv/app`. */
export function ancestorChain(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out = ["/"];
  let acc = "";
  for (const p of parts) {
    acc += `/${p}`;
    out.push(acc);
  }
  return out;
}

/** The visible rows, depth-first from `/`, descending only into expanded folders. */
export function flattenTree(children: TreeChildren, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (path: string, name: string, depth: number) => {
    const kids = children[path];
    const open = expanded.has(path);
    rows.push({
      path,
      name,
      depth,
      expanded: open,
      leaf: Array.isArray(kids) && kids.length === 0,
      loading: kids === "loading",
      error: kids && typeof kids === "object" && !Array.isArray(kids) ? kids.error : null,
    });
    if (open && Array.isArray(kids)) for (const k of kids) visit(k.path, k.name, depth + 1);
  };
  visit("/", "/", 0);
  return rows;
}

/** What a key press on the tree asks for. */
export type TreeAction =
  | { select: string }
  | { expand: string }
  | { collapse: string }
  | { pick: string }
  | null;

/**
 * The WAI-ARIA tree keys: ↑/↓ move, → opens (or steps into the first child), ←
 * closes (or steps out to the parent), Home/End jump, Enter picks the selection.
 */
export function treeKey(rows: TreeRow[], selected: string, key: string): TreeAction {
  const i = rows.findIndex((r) => r.path === selected);
  if (i < 0) return rows.length ? { select: rows[0].path } : null;
  const row = rows[i];
  switch (key) {
    case "ArrowDown":
      return i + 1 < rows.length ? { select: rows[i + 1].path } : null;
    case "ArrowUp":
      return i > 0 ? { select: rows[i - 1].path } : null;
    case "Home":
      return { select: rows[0].path };
    case "End":
      return { select: rows[rows.length - 1].path };
    case "ArrowRight":
      if (row.leaf) return null;
      if (!row.expanded) return { expand: row.path };
      return rows[i + 1]?.depth === row.depth + 1 ? { select: rows[i + 1].path } : null;
    case "ArrowLeft":
      if (row.expanded) return { collapse: row.path };
      return row.path === "/" ? null : { select: parentOf(row.path) };
    case "Enter":
      return { pick: row.path };
    default:
      return null;
  }
}
