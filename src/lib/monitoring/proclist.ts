// The full process list of the monitoring page (v1.33). Pure: the Processes
// section describes its list to `listview.ts` (filter, facets, one sort key) and
// asks here for the tree.
//
// CPU is % of one core over the last poll, counted in Rust from each process's
// ticks — not `ps`'s lifetime average. On the first poll there is no reading
// yet: such a process goes last in a CPU order rather than counting as idle.

import type { ProcRow } from "../api";
import { NO_GROUPS, type ListOrder, type ListSchema } from "../ui/listview";

const num = (v: number | null | undefined) => v ?? 0;

/**
 * A process's CPU against the whole machine, 0–100 (v1.35): its % of one core over
 * all the cores — what the list's bar is drawn against. A bar against one core
 * was full for 101 % and for 512 % alike. Null — not read yet, or the cores are
 * not known (a bar against a guessed ceiling would be a made-up share).
 */
export function machineShare(cpu: number | null, cores: number | null | undefined): number | null {
  if (cpu == null || !Number.isFinite(cpu) || cores == null || !(cores > 0)) return null;
  return Math.min(100, Math.max(0, cpu / cores));
}

/** How many cores' worth of work a % of one core is: 512 % — 5.1 cores. */
export const coresBusy = (cpu: number): number => cpu / 100;

/** The ceiling of a process's CPU chart: every core busy; null when the cores are not known. */
export function cpuCeiling(cores: number | null | undefined): number | null {
  return cores != null && cores > 0 ? cores * 100 : null;
}

/** How the Processes section filters and orders its list. */
export const PROC_SCHEMA: ListSchema<ProcRow> = {
  text: (p) => `${p.comm} ${p.user} ${p.pid}`,
  sorts: [
    { id: "cpu", firstDir: "desc", compare: (a, b) => num(a.cpu) - num(b.cpu), missing: (p) => p.cpu == null },
    { id: "mem", firstDir: "desc", compare: (a, b) => a.mem - b.mem },
    { id: "rss", firstDir: "desc", compare: (a, b) => num(a.rss) - num(b.rss), missing: (p) => p.rss == null },
    {
      id: "threads",
      firstDir: "desc",
      compare: (a, b) => num(a.threads) - num(b.threads),
      missing: (p) => p.threads == null,
    },
    {
      id: "age",
      firstDir: "desc",
      compare: (a, b) => num(a.elapsedSecs) - num(b.elapsedSecs),
      missing: (p) => p.elapsedSecs == null,
    },
    { id: "pid", firstDir: "asc", compare: (a, b) => a.pid - b.pid },
    { id: "name", firstDir: "asc", compare: (a, b) => a.comm.localeCompare(b.comm) },
    { id: "user", firstDir: "asc", compare: (a, b) => a.user.localeCompare(b.user) },
  ],
  facets: [
    { id: "user", value: (p) => p.user },
    { id: "state", value: (p) => p.state, order: ["running", "disk", "sleeping", "idle", "stopped", "zombie", "other"] },
  ],
  tie: (a, b) => a.pid - b.pid,
};

/** Busiest first. */
export const PROC_ORDER: ListOrder = { sort: { key: "cpu", dir: "desc" }, group: NO_GROUPS };

/** A row of the tree: the process, how deep it hangs, and whether it is only there to hold a match. */
export interface TreeRow {
  row: ProcRow;
  depth: number;
  /** Shown only because something under it matched the filter. */
  context: boolean;
  kids: number;
}

/** The deepest indentation drawn; a deeper chain lines up at this level. */
export const TREE_DEPTH_MAX = 12;

/**
 * `kept` (already filtered and sorted) as a tree by parent. A process whose parent
 * is not listed is a root. The parents of a kept process stand above it even when
 * the filter dropped them — dimmed, as context — so a match is never orphaned.
 * Siblings keep the order of `kept`; parents brought in as context take the order
 * of their first kept descendant.
 */
export function procTree(all: readonly ProcRow[], kept: readonly ProcRow[]): TreeRow[] {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const keptPids = new Set(kept.map((p) => p.pid));
  const rank = new Map<number, number>();
  kept.forEach((p, i) => rank.set(p.pid, i));

  // Every kept process and its listed ancestors.
  const shown = new Set<number>();
  for (const p of kept) {
    let cur: ProcRow | undefined = p;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      shown.add(cur.pid);
      if (!rank.has(cur.pid)) rank.set(cur.pid, rank.get(p.pid)!);
      else rank.set(cur.pid, Math.min(rank.get(cur.pid)!, rank.get(p.pid)!));
      cur = cur.ppid != null && cur.ppid !== cur.pid ? byPid.get(cur.ppid) : undefined;
    }
  }

  const kids = new Map<number, ProcRow[]>();
  const roots: ProcRow[] = [];
  for (const pid of shown) {
    const p = byPid.get(pid)!;
    const parent = p.ppid != null && p.ppid !== p.pid && shown.has(p.ppid) ? p.ppid : null;
    if (parent == null) roots.push(p);
    else kids.set(parent, [...(kids.get(parent) ?? []), p]);
  }
  const byRank = (a: ProcRow, b: ProcRow) => rank.get(a.pid)! - rank.get(b.pid)! || a.pid - b.pid;

  const out: TreeRow[] = [];
  const visited = new Set<number>();
  const walk = (p: ProcRow, depth: number) => {
    if (visited.has(p.pid)) return;
    visited.add(p.pid);
    const children = (kids.get(p.pid) ?? []).sort(byRank);
    out.push({ row: p, depth: Math.min(depth, TREE_DEPTH_MAX), context: !keptPids.has(p.pid), kids: children.length });
    for (const c of children) walk(c, depth + 1);
  };
  for (const r of roots.sort(byRank)) walk(r, 0);
  // A loop of parents has no root: what it holds is still listed, at the top level.
  for (const pid of [...shown].sort((a, b) => rank.get(a)! - rank.get(b)! || a - b)) walk(byPid.get(pid)!, 0);
  return out;
}

/** The processes worth a history line each: the busiest `n` by CPU and by memory. */
export function historyPids(rows: readonly ProcRow[], n = 40): Set<number> {
  const byCpu = [...rows].filter((p) => p.cpu != null).sort((a, b) => num(b.cpu) - num(a.cpu));
  const byMem = [...rows].sort((a, b) => b.mem - a.mem);
  return new Set([...byCpu.slice(0, n), ...byMem.slice(0, n)].map((p) => p.pid));
}
