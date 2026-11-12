// A line patch (ADR 0064): the edit made to a file on one server, carried to
// the same file on the others — where the text around it may differ. What
// `diff -u` and `patch` do, in the app: the change is cut into hunks with a few
// lines of context, and each hunk is looked for in the other file near where
// it stood, then a little further, then with less context. DOM-free (ADR 0003).
//
// Honest or not at all: every hunk says how it landed — where it stood, moved,
// with part of its context, at the file's edge, already there — and one that
// found no place makes the whole file a conflict: it is not written at all.

/** Lines of context around a change, as `diff -u`. */
export const CONTEXT = 3;

/** Past this many changed lines the files are too different to carry an edit between. */
export const MAX_EDIT = 2000;

export type OpKind = "=" | "-" | "+";

export interface Op {
  kind: OpKind;
  line: string;
}

/**
 * The shortest edit from `a` to `b`, line by line (Myers), or null past
 * `max` changed lines. The common head and tail are cut off first, so a small
 * edit of a large file costs what the edit costs.
 */
export function diffLines(a: readonly string[], b: readonly string[], max = MAX_EDIT): Op[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const mid = middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail), max);
  if (mid === null) return null;
  const same = (lines: readonly string[]) => lines.map((line): Op => ({ kind: "=", line }));
  return [...same(a.slice(0, head)), ...mid, ...same(a.slice(a.length - tail))];
}

function middle(a: readonly string[], b: readonly string[], max: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ kind: "+", line }));
  if (m === 0) return a.map((line) => ({ kind: "-", line }));
  // v[k] — the furthest x on diagonal k; each step's v is kept (only the
  // diagonals it can reach) to walk the path back.
  const trace: { lo: number; v: Int32Array }[] = [];
  let v = new Int32Array(3);
  let lo = -1;
  for (let d = 0; d <= Math.min(max, n + m); d++) {
    trace.push({ lo, v });
    const nlo = -d - 1;
    const next = new Int32Array(2 * d + 3);
    const at = (k: number) => (k - lo >= 0 && k - lo < v.length ? v[k - lo] : -1);
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[k - nlo] = x;
      if (x >= n && y >= m) return walkBack(trace, a, b, d);
    }
    v = next;
    lo = nlo;
  }
  return null;
}

function walkBack(trace: { lo: number; v: Int32Array }[], a: readonly string[], b: readonly string[], end: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = end; d >= 0; d--) {
    const { lo, v } = trace[d];
    const at = (k: number) => (k - lo >= 0 && k - lo < v.length ? v[k - lo] : -1);
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "=", line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "+", line: b[prevY] });
      else ops.push({ kind: "-", line: a[prevX] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** A piece of the edit, with the lines around it. */
export interface Hunk {
  /** Index in the old lines where `old` begins. */
  oldStart: number;
  /** The old lines of the piece: context, removed lines, context. */
  old: string[];
  /** What they become: context, added lines, context. */
  new: string[];
  /** Context lines at the start of `old` (and of `new`). */
  lead: number;
  /** Context lines at the end. */
  trail: number;
  /** `old` reaches the start / the end of the file. */
  atStart: boolean;
  atEnd: boolean;
}

/** The text as lines; a final newline leaves an empty last line, as on disk. */
export const linesOf = (text: string): string[] => text.split("\n");

/** The edit from `before` to `after` in hunks, or null when the files are too different. */
export function hunksOf(before: string, after: string, context = CONTEXT): Hunk[] | null {
  const a = linesOf(before);
  const ops = diffLines(a, linesOf(after));
  if (ops === null) return null;
  const oldPos: number[] = [];
  let p = 0;
  for (const op of ops) {
    oldPos.push(p);
    if (op.kind !== "+") p++;
  }
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === "=") {
      i++;
      continue;
    }
    let start = i;
    let lead = 0;
    while (lead < context && start > 0 && ops[start - 1].kind === "=") {
      start--;
      lead++;
    }
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end].kind !== "=") end++;
      let eq = end;
      while (eq < ops.length && ops[eq].kind === "=") eq++;
      if (eq < ops.length && eq - end <= 2 * context) {
        end = eq;
        continue;
      }
      break;
    }
    let stop = end;
    let trail = 0;
    while (trail < context && stop < ops.length && ops[stop].kind === "=") {
      stop++;
      trail++;
    }
    const piece = ops.slice(start, stop);
    const old = piece.filter((o) => o.kind !== "+").map((o) => o.line);
    const oldStart = oldPos[start];
    hunks.push({
      oldStart,
      old,
      new: piece.filter((o) => o.kind !== "-").map((o) => o.line),
      lead,
      trail,
      atStart: oldStart === 0,
      atEnd: oldStart + old.length === a.length,
    });
    i = stop;
  }
  return hunks;
}

/** How a hunk landed in the other file. */
export type HunkFate =
  /** Where it stood in the edited file. */
  | "clean"
  /** Its lines found, some lines away. */
  | "offset"
  /** Found with part of its context not matching. */
  | "fuzzy"
  /** Lines added at the start or the end of the file, whose neighbours differ there. */
  | "edge"
  /** The other file has it already. */
  | "already"
  /** No place found. */
  | "conflict";

/** What the edit made of the other file, as a whole. */
export type Outcome = "clean" | "offset" | "fuzzy" | "already" | "conflict";

export interface Patched {
  outcome: Outcome;
  /** The other file after the edit; null for a conflict (nothing is written). */
  text: string | null;
  fates: HunkFate[];
}

/** Where `block` stands in `lines` at or after `from`, nearest to `near`; −1 when nowhere. */
function findBlock(lines: readonly string[], block: readonly string[], from: number, near: number): number {
  if (block.length === 0) return -1;
  const last = lines.length - block.length;
  if (last < from) return -1;
  const fits = (pos: number) => {
    if (pos < from || pos > last) return false;
    for (let j = 0; j < block.length; j++) if (lines[pos + j] !== block[j]) return false;
    return true;
  };
  const centre = Math.min(Math.max(near, from), last);
  for (let dist = 0; centre - dist >= from || centre + dist <= last; dist++) {
    if (fits(centre - dist)) return centre - dist;
    if (dist > 0 && fits(centre + dist)) return centre + dist;
  }
  return -1;
}

/** `hunks` (the edit of another copy) carried into `target`. */
export function applyHunks(target: string, hunks: readonly Hunk[]): Patched {
  const t = linesOf(target);
  const out: string[] = [];
  const fates: HunkFate[] = [];
  let cursor = 0;
  let delta = 0;
  const land = (at: number, length: number, lines: readonly string[]) => {
    out.push(...t.slice(cursor, at), ...lines);
    cursor = at + length;
  };
  for (const h of hunks) {
    const expected = h.oldStart + delta;
    const oldAt = findBlock(t, h.old, cursor, expected);
    const newAt = findBlock(t, h.new, cursor, expected);
    if (newAt >= 0 && (oldAt < 0 || Math.abs(newAt - expected) <= Math.abs(oldAt - expected))) {
      land(newAt, h.new.length, h.new);
      delta = newAt - h.oldStart;
      fates.push("already");
      continue;
    }
    if (oldAt >= 0) {
      land(oldAt, h.old.length, h.new);
      fates.push(oldAt === expected ? "clean" : "offset");
      delta = oldAt - h.oldStart;
      continue;
    }
    const fuzzy = withLessContext(t, h, cursor, expected);
    if (fuzzy) {
      land(fuzzy.at, fuzzy.old, fuzzy.lines);
      fates.push("fuzzy");
      delta = fuzzy.at - fuzzy.oldStart;
      continue;
    }
    const edge = atTheEdge(t, h, cursor);
    if (edge === "already") {
      fates.push("already");
      continue;
    }
    if (edge) {
      land(edge.at, 0, edge.lines);
      fates.push("edge");
      continue;
    }
    fates.push("conflict");
  }
  if (fates.includes("conflict")) return { outcome: "conflict", text: null, fates };
  out.push(...t.slice(cursor));
  if (fates.every((f) => f === "already")) return { outcome: "already", text: target, fates };
  const outcome: Outcome =
    fates.includes("fuzzy") || fates.includes("edge") ? "fuzzy" : fates.includes("offset") ? "offset" : "clean";
  return { outcome, text: out.join("\n"), fates };
}

/** The hunk with its outer context dropped a line at a time, as `patch --fuzz`. */
function withLessContext(t: readonly string[], h: Hunk, cursor: number, expected: number) {
  for (let f = 1; f <= Math.max(h.lead, h.trail); f++) {
    const dl = Math.min(f, h.lead);
    const dt = Math.min(f, h.trail);
    const core = h.old.slice(dl, h.old.length - dt);
    if (core.length === 0) return null;
    const at = findBlock(t, core, cursor, expected + dl);
    if (at >= 0) return { at, old: core.length, lines: h.new.slice(dl, h.new.length - dt), oldStart: h.oldStart + dl };
  }
  return null;
}

/**
 * Lines only added, at the start or the end of the edited file, whose neighbours
 * the other file does not have: they go to its start or its end — "added at
 * the end" means the end there too. Already there — said so, not added twice.
 */
function atTheEdge(t: readonly string[], h: Hunk, cursor: number): { at: number; lines: string[] } | "already" | null {
  const added = h.new.slice(h.lead, h.new.length - h.trail);
  if (h.old.length !== h.lead + h.trail || added.length === 0) return null;
  if (h.atEnd) {
    const end = t.length > 0 && t[t.length - 1] === "" ? t.length - 1 : t.length;
    if (end < cursor) return null;
    const tail = t.slice(Math.max(0, end - added.length), end);
    if (tail.length === added.length && tail.every((l, i) => l === added[i])) return "already";
    return { at: end, lines: added };
  }
  if (h.atStart && cursor === 0) {
    const head = t.slice(0, added.length);
    if (head.length === added.length && head.every((l, i) => l === added[i])) return "already";
    return { at: 0, lines: added };
  }
  return null;
}

/** A line of a change as the preview shows it. */
export interface ViewLine {
  kind: OpKind | "gap";
  text: string;
}

/** The change from `before` to `after`, the unchanged lines beyond `context` folded into gaps. */
export function changeView(before: string, after: string, context = 2): ViewLine[] {
  const ops = diffLines(linesOf(before), linesOf(after));
  if (ops === null) return [];
  const near = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.kind === "=") return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) near[j] = true;
  });
  const out: ViewLine[] = [];
  ops.forEach((op, i) => {
    if (near[i]) out.push({ kind: op.kind, text: op.line });
    else if (out.length > 0 && out[out.length - 1].kind !== "gap") out.push({ kind: "gap", text: "" });
  });
  while (out.length > 0 && out[out.length - 1].kind === "gap") out.pop();
  return out;
}
