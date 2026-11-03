// Small pure view helpers for the Git panel (Phase 29) — kept out of components
// so they unit-test without DOM. Colors are the theme's status tokens, the same
// across the app; labels are resolved via i18n at the call site (these return
// canonical keys/letters only where noted).

import { compactAge } from "../ui/age";
import type { CommitFile, GitFile } from "./git";
import type { ListSchema } from "../ui/listview";
import { formatModified } from "../files/lscolors";

/**
 * Text-color class for a git status letter (name-status or porcelain). Theme
 * tokens, not palette classes: a fixed amber on a cream panel is a smudge, and
 * the lint rule `vterm/theme-colors` reads the classes a `.ts` file hands out as well.
 */
export function fileStatusColor(status: string): string {
  switch (status[0]) {
    case "A":
    case "?":
      return "text-ok";
    case "M":
    case "R":
    case "C":
      return "text-accent";
    case "D":
    case "U":
      return "text-bad";
    default:
      return "text-muted";
  }
}

/**
 * How long ago a commit was made (unix seconds), in the one age format every
 * list row uses — `45s`, `3h20m`, `5d4h`, `3w`, `8mo`, `2y` (`compactAge`).
 * `now` is injectable so the formatting is deterministic in tests.
 */
export function gitAge(tsSec: number, now: number = Date.now()): string {
  return compactAge(tsSec * 1000, now);
}

/**
 * When a commit was made, as a point in time: `2026-10-07 14:03`, local — the
 * form the file table shows a modification time in. A commit is compared with
 * a deploy, an incident, the clock on the wall; "3w" does not answer that.
 */
export const commitMoment = (tsSec: number): string => formatModified(tsSec || null);

/**
 * Which day a commit was made, for a moment worth saying in words: today and
 * yesterday read at a glance, an older one by its date. `now` is injectable.
 */
export function commitDay(tsSec: number, now: number = Date.now()): "today" | "yesterday" | null {
  const midnight = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((midnight(now) - midnight(tsSec * 1000)) / 86_400_000);
  return days === 0 ? "today" : days === 1 ? "yesterday" : null;
}

/** The time of day of a moment: `14:03`, local. */
export const clockTime = (tsSec: number): string => commitMoment(tsSec).slice(-5);

/** The history lists its author and moment in columns from this width of its own, rem. */
export const LOG_WIDE_REM = 36;

/**
 * Whether the history's rows are one line with columns, or two lines. The list has
 * a threshold of its own: beside the branches and the details it stands in less
 * than a panel's wide layout (`WIDE_REM`) while holding its columns well.
 */
export function isLogWide(widthPx: number, remPx = 16): boolean {
  return Number.isFinite(widthPx) && remPx > 0 && widthPx >= LOG_WIDE_REM * remPx;
}

/**
 * Compose the hover tooltip for a commit: full subject, then the body (if any),
 * then a metadata line (author · moment · age · short hash) — the row shows
 * only the age, so the date itself is here. `now` is injectable
 * for deterministic tests. Pure — the `.vt-tooltip` bubble renders `\n` as line
 * breaks (`white-space: pre-line`).
 */
export function commitTooltip(
  c: { subject: string; body: string; author: string; short: string; timestamp: number },
  now: number = Date.now(),
): string {
  const parts = [c.subject.trim()];
  const body = c.body.trim();
  if (body) parts.push(body);
  parts.push(`— ${c.author} · ${commitMoment(c.timestamp)} · ${gitAge(c.timestamp, now)} · ${c.short}`);
  return parts.join("\n\n");
}

/**
 * What the details pane says about who applied a commit — only when it adds
 * something to the author line: another person (a rebase or a cherry-pick by a
 * maintainer, `git am`) or another time (an amend, a rebase of one's own).
 * Null when the commit was applied by its author as it was written.
 */
export function committerLine(
  commit: { author: string; timestamp: number },
  detail: { authorEmail: string; committer: string; committerEmail: string; committed: number },
): { who: string; email: string; at: number } | null {
  const sameWho = detail.committer === commit.author && detail.committerEmail === detail.authorEmail;
  const sameWhen = !detail.committed || detail.committed === commit.timestamp;
  if (sameWho && sameWhen) return null;
  return { who: detail.committer, email: detail.committerEmail, at: detail.committed };
}

/** Every directory of a commit's file tree: what "collapse all" folds. */
export function commitTreeDirs(files: readonly CommitFile[]): Set<string> {
  const dirs = commitTree(files).flatMap((r) => (r.kind === "dir" ? [r.path] : []));
  return new Set(dirs);
}

/** Files of one commit the pane draws; the rest are counted, not drawn. */
export const COMMIT_FILES_SHOWN = 1000;

// ── The files of a commit as a tree ──────────────────────────────────────────
// A commit's files read by directory: forty paths in a flat list are forty
// prefixes to compare by eye. Directories that hold nothing but one directory
// are folded into one row (`docs/operations`), as an IDE's commit view does.

/** One row of a commit's file tree. */
export type CommitTreeRow =
  | {
      kind: "dir";
      /** Full path of the directory — the key it is folded by. */
      path: string;
      /** What the row shows: the directory's name, or a folded chain of them. */
      label: string;
      depth: number;
      /** Files under it, at any depth. */
      count: number;
      open: boolean;
    }
  | { kind: "file"; file: CommitFile; name: string; depth: number };

interface TreeDir {
  dirs: Map<string, TreeDir>;
  files: { name: string; file: CommitFile }[];
  count: number;
}

const newDir = (): TreeDir => ({ dirs: new Map(), files: [], count: 0 });
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The rows of a commit's file tree, top to bottom: directories before files,
 * each level sorted by name; a directory in `closed` shows its row and nothing
 * under it. Paths are git's — `/`-separated whatever the host.
 */
export function commitTree(
  files: readonly CommitFile[],
  closed: ReadonlySet<string> = new Set(),
): CommitTreeRow[] {
  const root = newDir();
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const name = parts.pop();
    if (name === undefined) continue;
    let dir = root;
    dir.count++;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) dir.dirs.set(part, (next = newDir()));
      next.count++;
      dir = next;
    }
    dir.files.push({ name, file });
  }

  const rows: CommitTreeRow[] = [];
  const walk = (dir: TreeDir, prefix: string, depth: number): void => {
    for (const first of [...dir.dirs.keys()].sort(byText)) {
      let node = dir.dirs.get(first)!;
      let label = first;
      // Fold a chain of directories that hold only the next one.
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [only, child] = [...node.dirs][0];
        label += `/${only}`;
        node = child;
      }
      const path = prefix + label;
      const open = !closed.has(path);
      rows.push({ kind: "dir", path, label, depth, count: node.count, open });
      if (open) walk(node, `${path}/`, depth + 1);
    }
    for (const { name, file } of [...dir.files].sort((a, b) => byText(a.name, b.name))) {
      rows.push({ kind: "file", file, name, depth });
    }
  };
  walk(root, "", 0);
  return rows;
}

/** A file's letter in one stage — untracked (`?`) reads `U`, as the list has always shown it. */
export function changeStatus(f: GitFile, staged: boolean): string {
  const c = staged ? f.index : f.work;
  return c === "?" ? "U" : c;
}

/** A row of the working-tree sub-tab: a changed file in one of the two stages. */
export interface ChangeItem {
  file: GitFile;
  staged: boolean;
}

/**
 * What the changes' filter row reads (v1.29, ADR 0050): the path, and the
 * status letter as the facet. The two stages stay the sections they are.
 */
export const CHANGE_SCHEMA: ListSchema<ChangeItem> = {
  text: (i) => i.file.path,
  sorts: [],
  facets: [{ id: "status", value: (i) => changeStatus(i.file, i.staged) }],
  tie: (a, b) => a.file.path.localeCompare(b.file.path),
};
