// Pure logic for the server-list tree (folders + servers). Extracted from
// +page.svelte so it can be unit-tested without a DOM. No Svelte/runtime deps.

import type { ServerProfile } from "./types";

/** Parent folder path of `p` ("" for a top-level path). */
export const parentOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

/** Leaf (last segment) of a folder path. */
export const nameOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

/** A server's effective folder path ("" = root); trims blank/whitespace groups. */
export const groupOf = (s: ServerProfile): string => s.group?.trim() || "";

/**
 * Filter servers by a free-text query against alias/host/username/group/tags.
 * An empty/whitespace query returns the list unchanged (same reference).
 */
export function filterServers(
  servers: ServerProfile[],
  search: string,
): ServerProfile[] {
  const q = search.trim().toLowerCase();
  if (!q) return servers;
  return servers.filter(
    (s) =>
      s.alias.toLowerCase().includes(q) ||
      s.host.toLowerCase().includes(q) ||
      s.username.toLowerCase().includes(q) ||
      groupOf(s).toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

/**
 * Servers whose effective folder is `path` or nested anywhere below it. Pure so
 * "what would deleting this folder take with it" is one tested definition, shared
 * by the tree's subtree counter and the delete-folder confirm dialog. The
 * trailing-slash guard stops `Prod` from swallowing `Production`.
 */
export function serversInSubtree(
  servers: ServerProfile[],
  path: string,
): ServerProfile[] {
  return servers.filter((s) => {
    const g = groupOf(s);
    return g === path || g.startsWith(path + "/");
  });
}

export type TreeRow =
  | { kind: "folder"; path: string; name: string; depth: number; count: number }
  | { kind: "server"; server: ServerProfile; depth: number };

export interface TreeInput {
  servers: ServerProfile[];
  folders: string[];
  /** Free-text search; when non-empty the tree flattens to filtered servers. */
  search: string;
  /** Folder paths whose subtree is collapsed. */
  collapsed: string[];
}

/**
 * Build the flat list of rows rendered by the server list.
 *
 * - While searching, returns a flat filtered list of servers (no folders).
 * - Otherwise builds the folder tree from the explicit folder list unioned with
 *   every server's group path and all its ancestors (so a server typed straight
 *   into the form is always reachable). Folders sort alphabetically; servers in a
 *   folder follow its child folders; root servers come last.
 */
export function buildTreeRows(input: TreeInput): TreeRow[] {
  const { servers, folders, search, collapsed } = input;

  if (search.trim()) {
    return filterServers(servers, search).map((s) => ({
      kind: "server",
      server: s,
      depth: 0,
    }));
  }

  const rows: TreeRow[] = [];
  const effective = new Set(folders);
  for (const s of servers) {
    let g = groupOf(s);
    while (g) {
      effective.add(g);
      g = parentOf(g);
    }
  }
  const allFolders = [...effective];
  const childFolders = (parent: string) =>
    allFolders
      .filter((f) => parentOf(f) === parent)
      .sort((a, b) => a.localeCompare(b));
  const serversIn = (path: string) =>
    servers.filter((s) => groupOf(s) === path);
  const subtreeCount = (path: string) => serversInSubtree(servers, path).length;

  const walk = (parent: string, depth: number) => {
    for (const f of childFolders(parent)) {
      rows.push({
        kind: "folder",
        path: f,
        name: nameOf(f),
        depth,
        count: subtreeCount(f),
      });
      if (!collapsed.includes(f)) {
        walk(f, depth + 1);
        for (const s of serversIn(f))
          rows.push({ kind: "server", server: s, depth: depth + 1 });
      }
    }
  };
  walk("", 0);
  for (const s of serversIn("")) rows.push({ kind: "server", server: s, depth: 0 });
  return rows;
}

/**
 * Whether the current drag may be dropped on `target` ("" = root, null = none).
 * A server drops anywhere; a folder may not drop on itself, a descendant, or its
 * own current parent (a no-op move).
 */
export function dropAllowed(
  target: string | null,
  dragKind: "server" | "folder" | null,
  dragId: string | null,
): boolean {
  if (target === null) return false;
  if (dragKind === "server") return true;
  if (dragKind === "folder" && dragId) {
    return (
      target !== dragId &&
      !target.startsWith(dragId + "/") &&
      target !== parentOf(dragId)
    );
  }
  return false;
}
