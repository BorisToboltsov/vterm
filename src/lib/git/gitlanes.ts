// The commit graph (pure): which lane and colour each commit and line takes, and
// the shape of a line between two rows. Input is `git log` order, newest first.
//
// The contract, which `gitlanes.test.ts` holds on arbitrary histories:
//  - a line keeps its lane and its colour for its whole length: a commit's first
//    parent stays where the commit is, and the lanes around it do not move;
//  - the main line is the leftmost lane in the first colour of the palette;
//  - a colour comes from the branch's name, never from a lane's number, so two
//    branches on the same lane are told apart and a refresh does not repaint them;
//  - an edge runs from the centre of one row to the centre of the next, so every
//    turn has the same shape (`edgePath`).

import { isFiltered, type GitCommit, type LogFilter } from "./git";

/** Colours a line can take: `--color-rail-0…6`. The first is the main line's alone. */
export const RAIL_COLORS = 7;

export interface GraphEdge {
  /** Lane at this row's centre. */
  from: number;
  /** Lane at the next row's centre. */
  to: number;
  color: number;
  /** The line it belongs to: the same id from a branch's tip to where it ends. */
  line: number;
  /**
   * Where it turns, if it does. `out` leaves a commit sideways and turns down at
   * the top of the band; `in` runs down its lane and turns into the commit below.
   */
  kind: "straight" | "out" | "in";
}

export interface GraphRow {
  commit: GitCommit;
  col: number;
  color: number;
  line: number;
  /** Lanes this row reaches, for the width of the graph. */
  lanes: number;
  /** The band from this row's centre to the next row's. */
  edges: GraphEdge[];
  /** A parent lies beyond what is loaded: the line goes on, out of the list. */
  cut: boolean;
}

/** The branches a history is read along, in order. */
const MAIN_BRANCHES = ["main", "master", "develop"];

/**
 * The commit the main line starts from: the local main branch, or the remote's,
 * or HEAD. Null when none is loaded.
 */
export function mainTip(commits: readonly GitCommit[]): string | null {
  const find = (test: (c: GitCommit) => boolean) => commits.find(test)?.hash ?? null;
  for (const name of MAIN_BRANCHES) {
    const tip =
      find((c) => c.refs.some((r) => (r.kind === "local" || r.kind === "head") && r.name === name)) ??
      find((c) => c.refs.some((r) => r.kind === "remote" && r.name.replace(/^[^/]+\//, "") === name));
    if (tip) return tip;
  }
  return find((c) => c.head);
}

/**
 * The commit the main line starts from for what a filter left. A search shows
 * scattered commits, so no line is the main one; one branch alone is read along
 * itself, from its tip.
 */
export function primaryFor(commits: readonly GitCommit[], filter: LogFilter): string | null {
  if (!isFiltered(filter)) return mainTip(commits);
  const onlyBranch = filter.branch && !filter.text && !filter.author && !filter.since && !filter.path;
  return onlyBranch ? (commits[0]?.hash ?? null) : null;
}

/** FNV-1a: small, stable, and enough to spread names over a few colours. */
function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** What names a line for its colour: the branch at its tip, `origin/x` and `x` alike. */
function colorSeed(commit: GitCommit): string {
  const ref = commit.refs.find((r) => r.kind !== "tag");
  if (!ref) return commit.hash;
  return ref.kind === "remote" ? ref.name.replace(/^[^/]+\//, "") : ref.name;
}

interface Slot {
  hash: string;
  color: number;
  line: number;
}

/** Assign every commit a lane and a colour, and every band between rows its edges. */
export function buildGraph(
  commits: readonly GitCommit[],
  primary: string | null = mainTip(commits),
): GraphRow[] {
  const index = new Map(commits.map((c, i) => [c.hash, i]));
  // A parent counts only if it is yet to come: a clock that ran backwards can put
  // a parent above its child, and a lane waiting for it would never close.
  const ahead = (parent: string, row: number): boolean => (index.get(parent) ?? -1) > row;

  const mainLine = new Set<string>();
  for (let h = primary; h !== null && index.has(h); ) {
    mainLine.add(h);
    const first: string | undefined = commits[index.get(h)!].parents[0];
    h = first !== undefined && ahead(first, index.get(h)!) ? first : null;
  }
  let mainLeft = mainLine.size;

  const slots: (Slot | null)[] = mainLine.size ? [null] : [];
  const lastColor = new Map<number, number>();
  let lines = 0;

  const freeSlot = (from: number): number => {
    for (let k = from; k < slots.length; k++) if (!slots[k]) return k;
    slots.push(null);
    return slots.length - 1;
  };
  // By name, then past the colours it would be mistaken for: its neighbours, the
  // line that last stood on its lane, the main line.
  const colorFor = (seed: string, at: number): number => {
    const sides = RAIL_COLORS - 1;
    const taken = new Set<number>([0]);
    for (const k of [at - 1, at + 1]) {
      const s = slots[k];
      if (s) taken.add(s.color);
    }
    const last = lastColor.get(at);
    if (last !== undefined) taken.add(last);
    let c = 1 + (hashText(seed) % sides);
    for (let n = 0; n < sides && taken.has(c); n++) c = 1 + (c % sides);
    return c;
  };

  const rows: GraphRow[] = [];
  commits.forEach((commit, i) => {
    const onMain = mainLine.has(commit.hash);
    let col = onMain ? 0 : slots.findIndex((s) => s?.hash === commit.hash);
    let color: number;
    let line: number;
    if (col >= 0 && slots[col]) {
      color = slots[col]!.color;
      line = slots[col]!.line;
    } else {
      if (col < 0) col = freeSlot(mainLeft > 0 ? 1 : 0);
      color = onMain ? 0 : colorFor(colorSeed(commit), col);
      line = ++lines;
    }
    // Every lane that was waiting for this commit ends here.
    slots.forEach((s, k) => {
      if (s?.hash !== commit.hash) return;
      lastColor.set(k, s.color);
      slots[k] = null;
    });
    if (onMain) mainLeft--;

    // Lines that leave this commit for another lane. `fresh`: that lane starts here;
    // otherwise it is already running, and keeps running under this one.
    const started = new Map<number, { color: number; line: number; fresh: boolean }>();
    let cut = false;
    commit.parents.forEach((parent, n) => {
      if (!ahead(parent, i)) {
        cut = true;
        return;
      }
      if (n === 0 && onMain) {
        slots[0] = { hash: parent, color, line };
        return;
      }
      const waiting = slots.findIndex((s) => s?.hash === parent);
      if (waiting >= 0) {
        // Its parent has a lane already: one line from here on, not two side by side.
        const s = slots[waiting]!;
        started.set(waiting, { ...(n === 0 ? { color, line } : { color: s.color, line: s.line }), fresh: false });
        return;
      }
      if (n === 0 && !slots[col]) {
        slots[col] = { hash: parent, color, line };
        return;
      }
      const lane = freeSlot(col + 1);
      const parentCommit = commits[index.get(parent)!];
      const parentColor = mainLine.has(parent) ? 0 : colorFor(colorSeed(parentCommit), lane);
      slots[lane] = { hash: parent, color: parentColor, line: ++lines };
      started.set(lane, { color: parentColor, line: slots[lane]!.line, fresh: true });
    });
    while (slots.length > 1 && !slots[slots.length - 1]) slots.pop();

    // The band down to the next row.
    const edges: GraphEdge[] = [];
    const next = commits[i + 1];
    if (next) {
      const waiting = mainLine.has(next.hash) ? 0 : slots.findIndex((s) => s?.hash === next.hash);
      slots.forEach((s, k) => {
        if (!s) return;
        const end = s.hash === next.hash && waiting >= 0 ? waiting : k;
        const start = started.get(k);
        if (!start?.fresh) edges.push({ from: k, to: end, color: s.color, line: s.line, kind: edgeKind(k, end, "in") });
        if (start) {
          // Sideways at once into a lane that goes on; into the row below, down and then in.
          const turn = end !== k || (!start.fresh && s.hash === next.hash) ? "in" : "out";
          edges.push({ from: col, to: end, color: start.color, line: start.line, kind: edgeKind(col, end, turn) });
        }
      });
    }
    const lanes = Math.max(col, ...edges.flatMap((e) => [e.from, e.to])) + 1;
    // Drawn in order: the main line goes last, on top of what crosses it.
    edges.sort((a, b) => Number(a.color === 0) - Number(b.color === 0));
    rows.push({ commit, col, color, line, lanes, edges, cut });
  });
  return rows;
}

const edgeKind = (from: number, to: number, turn: "out" | "in"): GraphEdge["kind"] =>
  from === to ? "straight" : turn;

/** The radius of every turn, px. */
export const TURN_RADIUS = 6;

/**
 * The SVG path of one edge between row centres `y1` and `y2`, with `x` placing a
 * lane. A straight line, or a run and a turn of one radius: however far a line
 * goes sideways, its corner is the same.
 */
export function edgePath(
  edge: Pick<GraphEdge, "from" | "to" | "kind">,
  y1: number,
  y2: number,
  x: (lane: number) => number,
  r = TURN_RADIUS,
): string {
  const x1 = x(edge.from);
  const x2 = x(edge.to);
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const d = Math.sign(x2 - x1);
  if (edge.kind === "out") {
    return `M${x1} ${y1}H${x2 - d * r}A${r} ${r} 0 0 ${d > 0 ? 1 : 0} ${x2} ${y1 + r}V${y2}`;
  }
  return `M${x1} ${y1}V${y2 - r}A${r} ${r} 0 0 ${d < 0 ? 1 : 0} ${x1 + d * r} ${y2}H${x2}`;
}

/** The commits HEAD reaches within what is loaded; empty when HEAD is not loaded. */
export function reachableFromHead(commits: readonly GitCommit[]): Set<string> {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const out = new Set<string>();
  const stack = commits.filter((c) => c.head).map((c) => c.hash);
  while (stack.length) {
    const hash = stack.pop()!;
    const commit = byHash.get(hash);
    if (!commit || out.has(hash)) continue;
    out.add(hash);
    stack.push(...commit.parents);
  }
  return out;
}
