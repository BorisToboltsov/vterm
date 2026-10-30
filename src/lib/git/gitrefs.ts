// The refs of a repository as the Git panel shows them (pure): a commit's labels,
// and branches and tags as a tree. Names are split on `/` the way git's own
// namespaces are, so `feat/x` and `feat/y` stand in one folder; a folder that holds
// nothing but one folder is folded into one row, as a commit's file tree is.

import type { GitBranch, GitRef, GitRefKind, GitTag } from "./git";

/** One label on a commit's row. */
export interface RefLabel {
  kind: GitRefKind;
  name: string;
  /** A local branch whose upstream stands on the same commit: one label, not two. */
  synced: boolean;
}

/**
 * A commit's refs as labels: the branch checked out first, then the local ones
 * (each swallowing its remote twin), the remote ones, the tags.
 */
export function refLabels(refs: readonly GitRef[], showTags = true): RefLabel[] {
  const shortOf = (r: GitRef): string => r.name.replace(/^[^/]+\//, "");
  const locals = refs.filter((r) => r.kind === "head" || r.kind === "local");
  const remotes = refs.filter((r) => r.kind === "remote");
  const names = new Set(locals.map((r) => r.name));
  return [
    ...[...locals]
      .sort((a, b) => Number(b.kind === "head") - Number(a.kind === "head"))
      .map((r) => ({ kind: r.kind, name: r.name, synced: remotes.some((o) => shortOf(o) === r.name) })),
    ...remotes.filter((r) => !names.has(shortOf(r))).map((r) => ({ kind: r.kind, name: r.name, synced: false })),
    ...(showTags ? refs.filter((r) => r.kind === "tag").map((r) => ({ kind: r.kind, name: r.name, synced: false })) : []),
  ];
}

// ── Favourites ───────────────────────────────────────────────────────────────

/** Starred out of the box: the branches almost every repository reads along. */
export const DEFAULT_FAVORITE_BRANCHES = ["main", "master", "develop"];

/** The stored list made safe: non-empty strings, each once. Storage outlives the build. */
export function sanitizeFavoriteBranches(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_FAVORITE_BRANCHES];
  return [...new Set(raw.filter((n): n is string => typeof n === "string" && n.trim() !== ""))];
}

export function toggledFavorite(favorites: readonly string[], name: string): string[] {
  return favorites.includes(name) ? favorites.filter((n) => n !== name) : [...favorites, name];
}

// ── The tree ─────────────────────────────────────────────────────────────────

export type RefSection = "local" | "remote" | "tags";

export type RefRow =
  | { kind: "section"; key: string; section: RefSection; count: number; open: boolean; depth: 0 }
  | { kind: "folder"; key: string; label: string; count: number; open: boolean; depth: number }
  | { kind: "branch"; key: string; branch: GitBranch; label: string; favorite: boolean; depth: number }
  | { kind: "tag"; key: string; tag: GitTag; label: string; depth: number };

interface Node<T> {
  dirs: Map<string, Node<T>>;
  leaves: { label: string; item: T }[];
  count: number;
}

const newNode = <T>(): Node<T> => ({ dirs: new Map(), leaves: [], count: 0 });
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function treeOf<T>(items: readonly T[], nameOf: (item: T) => string): Node<T> {
  const root = newNode<T>();
  for (const item of items) {
    const parts = nameOf(item).split("/").filter(Boolean);
    const label = parts.pop();
    if (label === undefined) continue;
    let node = root;
    node.count++;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, (next = newNode<T>()));
      next.count++;
      node = next;
    }
    node.leaves.push({ label, item });
  }
  return root;
}

export interface RefTreeInput {
  branches: readonly GitBranch[];
  tags: readonly GitTag[];
  favorites: readonly string[];
  /** Narrow to names holding this, any case. While it is set, everything left is open. */
  query?: string;
  /** Folded or unfolded by the user; `byDefault` is what it is otherwise. */
  isOpen?: (key: string, byDefault: boolean) => boolean;
}

/**
 * The rows of the tree, top to bottom: local branches (favourites first, whatever
 * their folder), then the remote ones and the tags. The local section is open, and
 * the folders on the way to the current branch; the rest wait to be asked for. A
 * section with nothing to show under a search is left out.
 */
export function refRows(input: RefTreeInput): RefRow[] {
  const q = (input.query ?? "").trim().toLowerCase();
  const matches = (name: string): boolean => !q || name.toLowerCase().includes(q);
  const isOpen = (key: string, byDefault: boolean): boolean =>
    q ? true : (input.isOpen?.(key, byDefault) ?? byDefault);

  const local = input.branches.filter((b) => !b.remote && matches(b.name));
  const remote = input.branches.filter((b) => b.remote && matches(b.name));
  const tags = input.tags.filter((t) => matches(t.name));
  const favorite = new Set(input.favorites);
  const current = input.branches.find((b) => b.current)?.name ?? "";

  const rows: RefRow[] = [];
  const walk = <T>(
    node: Node<T>,
    prefix: string,
    depth: number,
    leaf: (item: T, label: string, key: string, depth: number) => RefRow,
    defaultOpen: (path: string) => boolean,
    path = "",
  ): void => {
    for (const { label, item } of [...node.leaves].sort((a, b) => byText(a.label, b.label))) {
      rows.push(leaf(item, label, `${prefix}/${label}`, depth));
    }
    for (const first of [...node.dirs.keys()].sort(byText)) {
      let child = node.dirs.get(first)!;
      let label = first;
      while (child.leaves.length === 0 && child.dirs.size === 1) {
        const [only, next] = [...child.dirs][0];
        label += `/${only}`;
        child = next;
      }
      const key = `${prefix}/${label}`;
      const inner = path ? `${path}/${label}` : label;
      const open = isOpen(key, defaultOpen(inner));
      rows.push({ kind: "folder", key, label, count: child.count, open, depth });
      if (open) walk(child, key, depth + 1, leaf, defaultOpen, inner);
    }
  };
  const branchLeaf = (branch: GitBranch, label: string, key: string, depth: number): RefRow => ({
    kind: "branch",
    key,
    branch,
    label,
    favorite: favorite.has(branch.name),
    depth,
  });

  if (local.length || !q) {
    const open = isOpen("local", true);
    rows.push({ kind: "section", key: "local", section: "local", count: local.length, open, depth: 0 });
    if (open) {
      const starred = local.filter((b) => favorite.has(b.name)).sort((a, b) => byText(a.name, b.name));
      for (const b of starred) rows.push(branchLeaf(b, b.name, `local/*/${b.name}`, 1));
      walk(
        treeOf(local.filter((b) => !favorite.has(b.name)), (b) => b.name),
        "local",
        1,
        branchLeaf,
        (path) => current.startsWith(`${path}/`),
      );
    }
  }
  if (remote.length || !q) {
    const open = isOpen("remote", false);
    rows.push({ kind: "section", key: "remote", section: "remote", count: remote.length, open, depth: 0 });
    if (open) walk(treeOf(remote, (b) => b.name), "remote", 1, branchLeaf, () => false);
  }
  if (tags.length || !q) {
    const open = isOpen("tags", false);
    rows.push({ kind: "section", key: "tags", section: "tags", count: tags.length, open, depth: 0 });
    if (open) {
      walk(
        treeOf(tags, (t) => t.name),
        "tags",
        1,
        (tag, label, key, depth) => ({ kind: "tag", key, tag, label, depth }),
        () => false,
      );
    }
  }
  return rows;
}

/** Every key the tree could fold: what "expand all" opens and "collapse all" closes. */
export function allFolderKeys(input: Omit<RefTreeInput, "isOpen" | "query">): string[] {
  return refRows({ ...input, isOpen: () => true })
    .filter((r) => r.kind === "section" || r.kind === "folder")
    .map((r) => r.key);
}

/** The commit a branch or a tag stands on, among those loaded, by its short hash. */
export function findByShort<T extends { hash: string }>(items: readonly T[], short: string): T | undefined {
  return short ? items.find((c) => c.hash.startsWith(short)) : undefined;
}

/** The full ref a tag or a branch is filtered by. */
export const tagRef = (tag: Pick<GitTag, "name">): string => `refs/tags/${tag.name}`;
