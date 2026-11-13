// Where a pipeline's jobs stand and how their links run (ADR 0068). Columns are
// GitLab's stages, or — on GitHub, and in GitLab's "links" view — how far a job
// is down its `needs`. A job is pulled level with what it waits on, so most
// links run straight; a link that crosses columns runs in the gap between rows
// and never through a job. Every turn has one radius, as the Git history's
// lines do (`gitlanes.ts`). Geometry in units at 100 % scale — the component
// multiplies (`uiPx`). Pure: no DOM.

import { dependsOn, type PipeJob, type Pipeline } from "./pipeline";

export type GraphMode = "stages" | "links";

export interface LayoutMetrics {
  /** Height of a job's own line. */
  node: number;
  /** Height of one line under it (a matrix copy, a called job). */
  sub: number;
  /** The rows' pitch: a job line and the gap under it. */
  row: number;
  /** Space between columns, where links turn. */
  gutter: number;
  padX: number;
  /** Space above the first row (stage titles). */
  top: number;
  /** Narrowest a column gets before the graph scrolls sideways. */
  minColumn: number;
  /** Widest a column gets: a job is a card, not a bar across the window. */
  maxColumn: number;
  radius: number;
  /** The events on the left: their width, height and the gap between them. */
  event: number;
  eventH: number;
  eventGap: number;
}

export const METRICS: LayoutMetrics = {
  node: 26,
  sub: 22,
  row: 34,
  gutter: 42,
  padX: 12,
  top: 30,
  minColumn: 128,
  maxColumn: 260,
  radius: 8,
  event: 128,
  eventH: 22,
  eventGap: 8,
};

export interface NodeBox {
  id: string;
  col: number;
  row: number;
  /** Rows the job takes: more than one when its copies or called jobs are shown. */
  span: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** SVG path. */
  d: string;
  /** GitLab's wait for the stage before, not a written `needs`. */
  implicit: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLayout {
  nodes: Map<string, NodeBox>;
  edges: GraphEdge[];
  /** The events that start the pipeline, in a column on the left. */
  events: Map<string, Box>;
  /** From each event to each job the pipeline starts with — one bus they share. */
  triggers: { event: string; to: string; d: string }[];
  /** Column titles (GitLab stages in the stages view). */
  columns: { x: number; w: number; title: string | null }[];
  width: number;
  height: number;
}

/** Lines shown under a job: its matrix copies when opened, the jobs it calls. */
export function subLines(job: PipeJob, open: boolean): string[] {
  if (job.call?.pipeline) return job.call.pipeline.jobs.map((j) => j.name + (j.matrix?.items ? ` ×${j.matrix.items.length}` : ""));
  if (job.matrix?.items && open) return job.matrix.items;
  return [];
}

/** A polyline with every corner rounded by one radius (shorter where a leg is short). */
export function roundedPath(points: readonly (readonly [number, number])[], radius: number): string {
  const p = points.filter((q, i) => i === 0 || Math.abs(q[0] - points[i - 1][0]) + Math.abs(q[1] - points[i - 1][1]) > 0.01);
  if (p.length === 0) return "";
  const n = (v: number) => Math.round(v * 100) / 100;
  let d = `M${n(p[0][0])} ${n(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = p[i - 1];
    const [bx, by] = p[i];
    const [cx, cy] = p[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay);
    const l2 = Math.hypot(cx - bx, cy - by);
    const u = [(bx - ax) / l1, (by - ay) / l1];
    const v = [(cx - bx) / l2, (cy - by) / l2];
    const cross = u[0] * v[1] - u[1] * v[0];
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (Math.abs(cross) < 1e-6 || r < 0.5) {
      d += ` L${n(bx)} ${n(by)}`;
      continue;
    }
    d += ` L${n(bx - u[0] * r)} ${n(by - u[1] * r)} A${n(r)} ${n(r)} 0 0 ${cross > 0 ? 1 : 0} ${n(bx + v[0] * r)} ${n(by + v[1] * r)}`;
  }
  const z = p[p.length - 1];
  return `${d} L${n(z[0])} ${n(z[1])}`;
}

/** Each job's column: its stage, or how deep it is down what it waits on. */
export function columnsOf(pipeline: Pipeline, mode: GraphMode): { col: Map<string, number>; titles: (string | null)[] } {
  const col = new Map<string, number>();
  if (pipeline.kind === "gitlab" && mode === "stages") {
    const used = pipeline.stages.filter((s) => pipeline.jobs.some((j) => j.stage === s));
    for (const job of pipeline.jobs) col.set(job.id, Math.max(0, used.indexOf(job.stage ?? "")));
    return { col, titles: used };
  }
  const depth = (job: PipeJob, seen: Set<string>): number => {
    const known = col.get(job.id);
    if (known !== undefined) return known;
    if (seen.has(job.id)) return 0;
    seen.add(job.id);
    const deps = dependsOn(pipeline, job);
    const d = deps.length ? Math.max(...deps.map((id) => depth(pipeline.jobs.find((j) => j.id === id)!, seen))) + 1 : 0;
    col.set(job.id, d);
    return d;
  };
  pipeline.jobs.forEach((j) => depth(j, new Set()));
  const n = Math.max(0, ...col.values()) + 1;
  return { col, titles: Array.from({ length: n }, () => null) };
}

/** The links drawn: written `needs`; in GitLab's links view also the wait for the stage before. */
function linksOf(pipeline: Pipeline, mode: GraphMode, col: Map<string, number>): { from: string; to: string; implicit: boolean }[] {
  const out: { from: string; to: string; implicit: boolean }[] = [];
  for (const job of pipeline.jobs) {
    if (job.needs) {
      for (const n of job.needs) if (col.has(n.job)) out.push({ from: n.job, to: job.id, implicit: false });
      continue;
    }
    if (pipeline.kind !== "gitlab" || mode !== "links") continue;
    const deps = dependsOn(pipeline, job);
    if (!deps.length) continue;
    const last = Math.max(...deps.map((d) => col.get(d) ?? 0));
    for (const d of deps) if (col.get(d) === last) out.push({ from: d, to: job.id, implicit: true });
  }
  return out;
}

export interface LayoutInput {
  mode: GraphMode;
  /** Width there is; the graph is wider when its columns would be too narrow. */
  width: number;
  /** Jobs whose matrix copies are shown. */
  open: ReadonlySet<string>;
  /** Events to draw on the left, by key, in order; none — no event column. */
  events?: readonly string[];
  metrics?: LayoutMetrics;
}

/** The jobs a pipeline starts with: those that wait for nothing. */
export function startJobs(pipeline: Pipeline): PipeJob[] {
  return pipeline.jobs.filter((j) => dependsOn(pipeline, j).length === 0);
}

export function layoutPipeline(pipeline: Pipeline, input: LayoutInput): GraphLayout {
  const m = input.metrics ?? METRICS;
  const { col, titles } = columnsOf(pipeline, input.mode);
  const ncol = Math.max(1, titles.length);
  const eventIds = input.events ?? [];
  const lead = eventIds.length ? m.event + m.gutter : 0;
  const x0 = m.padX + lead;
  const cw = Math.min(m.maxColumn, Math.max(m.minColumn, (input.width - 2 * m.padX - lead - m.gutter * (ncol - 1)) / ncol));
  const width = Math.max(input.width, 2 * m.padX + lead + ncol * cw + (ncol - 1) * m.gutter);
  const heightOf = (job: PipeJob) => {
    const lines = subLines(job, input.open.has(job.id)).length;
    return lines ? m.node + lines * m.sub + 6 : m.node;
  };
  const spanOf = (job: PipeJob) => Math.ceil((heightOf(job) + m.row - m.node) / m.row);
  const deps = (job: PipeJob) => dependsOn(pipeline, job);
  const rowOf = new Map<string, number>();
  for (let c = 0; c < ncol; c++) {
    const here = pipeline.jobs.filter((j) => col.get(j.id) === c);
    const before = (j: PipeJob) => deps(j).filter((d) => (col.get(d) ?? 0) < c && rowOf.has(d));
    const bary = (j: PipeJob) => {
      const s = before(j);
      return s.length ? s.reduce((a, d) => a + rowOf.get(d)!, 0) / s.length : -1;
    };
    const near = (j: PipeJob) => {
      const s = before(j);
      return s.length ? -Math.max(...s.map((d) => col.get(d) ?? 0)) : 0;
    };
    const sameCol = (j: PipeJob) => (j.needs ?? []).map((n) => n.job).find((n) => col.get(n) === c && n !== j.id);
    const sorted = here
      .map((j, i) => ({ j, b: bary(j), n: near(j), i }))
      .sort((a, b) => a.b - b.b || a.n - b.n || a.i - b.i)
      .map((x) => x.j);
    const order: PipeJob[] = [];
    const put = (j: PipeJob) => {
      if (order.includes(j)) return;
      order.push(j);
      sorted.filter((k) => sameCol(k) === j.id).forEach(put);
    };
    sorted.filter((j) => !sameCol(j)).forEach(put);
    sorted.forEach(put); // what a loop of same-column needs left out
    let next = 0;
    for (const j of order) {
      const s = sameCol(j);
      const want = s && rowOf.has(s) ? rowOf.get(s)! + spanOf(pipeline.jobs.find((x) => x.id === s)!) : Math.max(0, Math.round(bary(j) - 0.01));
      const r = Math.max(next, want);
      rowOf.set(j.id, r);
      next = r + spanOf(j);
    }
  }
  const nodes = new Map<string, NodeBox>();
  let rows = 0;
  for (const job of pipeline.jobs) {
    const c = col.get(job.id) ?? 0;
    const r = rowOf.get(job.id) ?? 0;
    const span = spanOf(job);
    nodes.set(job.id, { id: job.id, col: c, row: r, span, x: x0 + c * (cw + m.gutter), y: m.top + r * m.row, w: cw, h: heightOf(job) });
    rows = Math.max(rows, r + span);
  }
  const edges = linksOf(pipeline, input.mode, col).map((l) => ({ ...l, d: route(nodes, nodes.get(l.from)!, nodes.get(l.to)!, m) }));
  const columns = titles.map((title, c) => ({ x: x0 + c * (cw + m.gutter), w: cw, title }));
  // The events stand level with the jobs they start, one under another.
  const events = new Map<string, Box>();
  const triggers: GraphLayout["triggers"] = [];
  let bottom = m.top + rows * m.row + 6;
  const starts = startJobs(pipeline).map((j) => nodes.get(j.id)!);
  if (eventIds.length) {
    const mids = starts.length ? starts.map((b) => b.y + m.node / 2 - 1) : [m.top + m.node / 2];
    const centre = (Math.min(...mids) + Math.max(...mids)) / 2;
    const total = eventIds.length * m.eventH + (eventIds.length - 1) * m.eventGap;
    const y0 = Math.max(m.top, centre - total / 2);
    eventIds.forEach((id, i) => {
      const box = { x: m.padX, y: y0 + i * (m.eventH + m.eventGap), w: m.event, h: m.eventH };
      events.set(id, box);
      // A pseudo-job in the column before the first: links leave it as they leave a job.
      const from: NodeBox = { id, col: -1, row: -1, span: 1, ...box };
      for (const to of starts) triggers.push({ event: id, to: to.id, d: route(nodes, from, to, m, box.y + box.h / 2) });
    });
    bottom = Math.max(bottom, y0 + total + 6);
  }
  return { nodes, edges, columns, events, triggers, width, height: bottom };
}

/** A gap between rows of a column that no job covers. */
function gapFree(nodes: Map<string, NodeBox>, gy: number, c: number): boolean {
  for (const b of nodes.values()) if (b.col === c && gy > b.y - 3 && gy < b.y + b.h + 3) return false;
  return true;
}

/**
 * A link's path: from the right of `from` to the left of `to`. Into the next
 * column it turns once in the gutter (every link into a job meets on one line
 * there); farther, it runs along the free gap between rows nearest its ends.
 * Within one column it drops straight down to the job just under, or loops on
 * the left.
 */
function route(nodes: Map<string, NodeBox>, s: NodeBox, t: NodeBox, m: LayoutMetrics, fromY?: number): string {
  const mid = m.node / 2 - 1;
  const sy = fromY ?? s.y + mid;
  const ty = t.y + mid;
  if (t.col === s.col) {
    const x = s.x + 22;
    if (t.row === s.row + s.span) return roundedPath([[x, s.y + s.h], [x, t.y]], m.radius);
    const lx = s.x - Math.min(14, m.gutter / 3);
    return roundedPath([[s.x, sy], [lx, sy], [lx, ty], [t.x, ty]], m.radius);
  }
  if (t.col < s.col) {
    // Against the flow (a written need on a later stage) — drawn, and reported elsewhere.
    return roundedPath([[s.x, sy], [s.x - m.gutter / 2, sy], [s.x - m.gutter / 2, ty], [t.x + t.w, ty]], m.radius);
  }
  const sx = s.x + s.w;
  const tx = t.x;
  const bus = tx - m.gutter / 2;
  if (t.col === s.col + 1) return roundedPath([[sx, sy], [bus, sy], [bus, ty], [tx, ty]], m.radius);
  const out = sx + m.gutter * 0.28;
  const maxRow = Math.max(...[...nodes.values()].map((b) => b.row + b.span)) + 1;
  let best: { gy: number; cost: number } | null = null;
  for (let k = 0; k <= maxRow; k++) {
    const gy = m.top + k * m.row - (m.row - m.node) / 2 - 1;
    let free = true;
    for (let c = s.col + 1; c < t.col && free; c++) free = gapFree(nodes, gy, c);
    if (!free) continue;
    const cost = Math.abs(gy - sy) + Math.abs(gy - ty) + Math.abs(gy - ty) * 0.01;
    if (!best || cost < best.cost) best = { gy, cost };
  }
  const gy = best ? best.gy : m.top - 6;
  return roundedPath([[sx, sy], [out, sy], [out, gy], [bus, gy], [bus, ty], [tx, ty]], m.radius);
}

// ── The map of a group ───────────────────────────────────────────────────────

export interface MapInput {
  /** Pipelines in order; `called` — started only by another one. */
  cards: { id: string; called: boolean; lines: number }[];
  /** Events and the cards each starts. */
  events: { id: string; to: string[] }[];
  /** Calls between cards (reusable workflows, child pipelines, `workflow_run`). */
  calls: { from: string; to: string }[];
  width: number;
  /** The interface scale (`uiPx(1)`): the cards hold text in rem. */
  scale?: number;
}

export interface MapLayout {
  events: Map<string, { x: number; y: number; w: number; h: number }>;
  cards: Map<string, { x: number; y: number; w: number; h: number }>;
  links: { key: string; from: string; to: string; call: boolean; d: string }[];
  width: number;
  height: number;
}

/**
 * The map's geometry at 100 %, taken from the card's markup (`PipelinesTab`): a
 * card is `py-1.5` + a `text-xs` header (16) + `mt-1` + its job lines, each a
 * `leading-4` line (16) and a `gap-y-0.5` (2) under it, and two borders —
 * 32 + 18 per line. The header's middle is 15 down. Every value is multiplied
 * by the interface scale, as the text the card holds grows with it.
 */
const MAP = {
  pad: 12,
  event: 128,
  gap: 46,
  card: 250,
  called: 200,
  head: 32,
  headMid: 15,
  line: 18,
  cardGap: 12,
  eventH: 22,
  eventGap: 10,
  radius: 8,
};

const scaledMap = (k: number): typeof MAP =>
  Object.fromEntries(Object.entries(MAP).map(([key, v]) => [key, v * k])) as typeof MAP;

/** Width of one character of a card's job list (monospace, `text-caption`). */
const CARD_CHAR = 6.1;
/** What a job takes besides its name: the state icon and the gap after it. */
const CARD_ITEM_EXTRA = 3;

/**
 * How many lines a card's jobs take: the names wrap as the card wraps them,
 * a whole name to a line when it does not fit beside the one before.
 */
export function cardLines(names: readonly string[], called: boolean): number {
  const room = Math.floor(((called ? MAP.called : MAP.card) - 20) / CARD_CHAR);
  let lines = 1;
  let used = 0;
  for (const name of names) {
    const len = Math.min(room, name.length + CARD_ITEM_EXTRA);
    if (used > 0 && used + len > room) {
      lines++;
      used = 0;
    }
    used += len;
  }
  return lines;
}

/** Events on the left, pipelines in the middle, the ones only called on the right. */
export function layoutMap(input: MapInput): MapLayout {
  const M = scaledMap(input.scale ?? 1);
  const top = input.cards.filter((c) => !c.called);
  const called = input.cards.filter((c) => c.called);
  const cardX = M.pad + M.event + M.gap;
  const calledX = cardX + M.card + M.gap;
  const width = Math.max(input.width, (called.length ? calledX + M.called : cardX + M.card) + M.pad);
  const cards = new Map<string, { x: number; y: number; w: number; h: number }>();
  const stack = (list: typeof top, x: number, w: number) => {
    let y = M.pad;
    for (const c of list) {
      const h = M.head + Math.max(1, c.lines) * M.line;
      cards.set(c.id, { x, y, w, h });
      y += h + M.cardGap;
    }
    return y;
  };
  let height = stack(top, cardX, M.card);
  // A called pipeline stands level with the first card that calls it.
  let y = M.pad;
  for (const c of called) {
    const caller = input.calls.find((l) => l.to === c.id && cards.has(l.from));
    const at = caller ? cards.get(caller.from)!.y : y;
    const h = M.head + Math.max(1, c.lines) * M.line;
    const placed = Math.max(at, y);
    cards.set(c.id, { x: calledX, y: placed, w: M.called, h });
    y = placed + h + M.cardGap;
  }
  height = Math.max(height, y);
  const centre = (id: string) => cards.get(id)!.y + M.headMid;
  const events = new Map<string, { x: number; y: number; w: number; h: number }>();
  let prev = -Infinity;
  input.events
    .map((e, i) => ({ e, i, want: e.to.length ? e.to.reduce((a, t) => a + centre(t), 0) / e.to.length - M.eventH / 2 : M.pad }))
    .sort((a, b) => a.want - b.want || a.i - b.i)
    .forEach(({ e, want }) => {
      const ey = Math.max(want, prev + M.eventH + M.eventGap, M.pad);
      events.set(e.id, { x: M.pad, y: ey, w: M.event, h: M.eventH });
      prev = ey;
    });
  height = Math.max(height, prev + M.eventH + M.pad);
  const links: MapLayout["links"] = [];
  const laneStart = M.pad + M.event;
  input.events.forEach((e, i) => {
    const s = events.get(e.id)!;
    const lane = laneStart + M.gap * (0.22 + (0.56 * i) / Math.max(1, input.events.length - 1));
    for (const t of e.to) {
      const c = cards.get(t);
      if (!c) continue;
      links.push({ key: `ev:${e.id}|${t}`, from: `ev:${e.id}`, to: t, call: false, d: roundedPath([[s.x + s.w, s.y + s.h / 2], [lane, s.y + s.h / 2], [lane, centre(t)], [c.x, centre(t)]], M.radius) });
    }
  });
  input.calls.forEach((l, i) => {
    const a = cards.get(l.from);
    const b = cards.get(l.to);
    if (!a || !b) return;
    if (b.x > a.x) {
      const bus = b.x - M.gap / 2;
      links.push({ key: `${l.from}|${l.to}`, from: l.from, to: l.to, call: true, d: roundedPath([[a.x + a.w, centre(l.from)], [bus, centre(l.from)], [bus, centre(l.to)], [b.x - 3, centre(l.to)]], M.radius) });
    } else {
      // Same column: a bracket on the right, one lane per call.
      const x = a.x + a.w + 14 + (i % 3) * 6;
      const from = centre(l.from);
      const to = b.y + b.h - 10;
      links.push({ key: `${l.from}|${l.to}`, from: l.from, to: l.to, call: true, d: roundedPath([[a.x + a.w, from], [x, from], [x, to], [b.x + b.w + 3, to]], M.radius) });
    }
  });
  return { events, cards, links, width, height: height + 6 };
}

// ── The run of a group, as lanes ─────────────────────────────────────────────

export interface LanesInput {
  /** Lanes top to bottom; `depth` — how far down calls it stands (indented). */
  lanes: readonly { key: string; depth: number }[];
  /** Jobs: their lane, their wave (the column, from 1) and their row in it. */
  nodes: readonly { key: string; lane: string; wave: number; row: number }[];
  links: readonly { from: string; to: string; kind: string }[];
  waves: number;
  /** What starts the run: the key links name it by. */
  event: string;
  /** The cards the event starts nothing in: small boxes in a row under the lanes. */
  idle: readonly string[];
  width: number;
  /** The interface scale (`uiPx(1)`). */
  scale?: number;
}

export interface LanesLayout {
  lanes: Map<string, Box>;
  nodes: Map<string, Box>;
  event: Box;
  /** Each wave's column, for its title and the line that marks the wave running. */
  columns: Box[];
  links: { key: string; from: string; to: string; kind: string; d: string }[];
  idle: Map<string, Box>;
  /** The title of the row of cards not started, when there are any. */
  idleTitle: Box | null;
  width: number;
  height: number;
}

/**
 * The lanes' geometry at 100 %: the event's column on the left, then one column
 * per wave. A lane is its title (`laneHead`) and its rows; a job is as tall as
 * a job of the pipeline's own graph.
 */
const LANES = {
  pad: 12,
  event: 128,
  eventH: 22,
  gap: 44,
  head: 24,
  laneHead: 24,
  node: 26,
  row: 32,
  lanePad: 4,
  laneGap: 8,
  indent: 10,
  minColumn: 150,
  maxJob: 220,
  gutter: 36,
  radius: 8,
  idleW: 150,
  idleH: 24,
  idleGap: 6,
  idleTitle: 18,
};

/** Lanes stacked under the wave titles; links turn in the gutters and never cross a job. */
export function layoutLanes(input: LanesInput): LanesLayout {
  const M = Object.fromEntries(Object.entries(LANES).map(([key, v]) => [key, v * (input.scale ?? 1)])) as typeof LANES;
  const waves = Math.max(1, input.waves);
  const x0 = M.pad + M.event + M.gap;
  // As wide as a job and its gutter at most: a wide window does not pull the waves apart.
  const colW = Math.min(M.maxJob + M.gutter, Math.max(M.minColumn, (input.width - x0 - M.pad) / waves));
  const width = Math.max(input.width, x0 + waves * colW + M.pad);
  const jw = Math.min(M.maxJob, colW - M.gutter);
  const colX = (wave: number) => x0 + (wave - 1) * colW;
  const columns = Array.from({ length: waves }, (_, i) => ({ x: colX(i + 1), y: 0, w: colW, h: M.head }));

  const lanes = new Map<string, Box>();
  const nodes = new Map<string, Box>();
  /** Lines between rows and between lanes a link may run along. */
  const gaps: number[] = [];
  let y = M.head;
  for (const lane of input.lanes) {
    const mine = input.nodes.filter((n) => n.lane === lane.key);
    const rows = mine.length ? Math.max(...mine.map((n) => n.row)) + 1 : 0;
    const x = x0 - M.gutter / 2 + Math.min(2, lane.depth) * M.indent;
    const h = M.laneHead + rows * M.row + M.lanePad;
    lanes.set(lane.key, { x, y, w: width - M.pad - x, h });
    for (const n of mine) nodes.set(n.key, { x: colX(n.wave) + (colW - jw) / 2, y: y + M.laneHead + n.row * M.row + (M.row - M.node) / 2, w: jw, h: M.node });
    for (let r = 1; r < rows; r++) gaps.push(y + M.laneHead + r * M.row);
    gaps.push(y + h + M.laneGap / 2);
    y += h + M.laneGap;
  }

  // The event stands level with the jobs it starts.
  const started = input.links.filter((l) => l.from === input.event).map((l) => nodes.get(l.to)).filter((b): b is Box => !!b);
  const mids = started.map((b) => b.y + b.h / 2);
  const centre = mids.length ? (Math.min(...mids) + Math.max(...mids)) / 2 : M.head + M.eventH / 2;
  const event = { x: M.pad, y: centre - M.eventH / 2, w: M.event, h: M.eventH };

  const boxes = [...nodes.values()];
  const blocked = (x1: number, x2: number, ly: number, except: Box[]) =>
    boxes.some((b) => !except.includes(b) && b.x < Math.max(x1, x2) && b.x + b.w > Math.min(x1, x2) && ly > b.y - 2 && ly < b.y + b.h + 2);
  // Into the first wave the lines turn left of the lanes, clear of their titles.
  const firstBus = M.pad + M.event + (M.gap - M.gutter / 2) / 2;
  const links = input.links.flatMap((l) => {
    const s = l.from === input.event ? event : nodes.get(l.from);
    const t = nodes.get(l.to);
    if (!s || !t) return [];
    const sx = s.x + s.w;
    const sy = s.y + s.h / 2;
    const tx = t.x;
    const ty = t.y + t.h / 2;
    const bus = tx < x0 + colW ? firstBus : tx - M.gutter / 2;
    let points: [number, number][] = [[sx, sy], [bus, sy], [bus, ty], [tx, ty]];
    if (blocked(sx, bus, sy, [s, t])) {
      // Along the free line between rows nearest its ends.
      const out = sx + M.gutter * 0.3;
      const free = gaps.filter((g) => !blocked(out, bus, g, [s, t]));
      const gy = free.length ? free.reduce((a, b) => (Math.abs(b - sy) + Math.abs(b - ty) < Math.abs(a - sy) + Math.abs(a - ty) ? b : a)) : M.head - 4;
      points = [[sx, sy], [out, sy], [out, gy], [bus, gy], [bus, ty], [tx, ty]];
    }
    return [{ key: `${l.from}>${l.to}`, from: l.from, to: l.to, kind: l.kind, d: roundedPath(points, M.radius) }];
  });

  // The cards the event starts nothing in: a row under the lanes.
  const idle = new Map<string, Box>();
  let idleTitle: Box | null = null;
  let bottom = Math.max(y, event.y + event.h + M.pad);
  if (input.idle.length) {
    idleTitle = { x: M.pad, y: bottom + 2, w: width - 2 * M.pad, h: M.idleTitle };
    let ix = M.pad;
    let iy = idleTitle.y + M.idleTitle + 2;
    for (const id of input.idle) {
      if (ix > M.pad && ix + M.idleW > width - M.pad) {
        ix = M.pad;
        iy += M.idleH + M.idleGap;
      }
      idle.set(id, { x: ix, y: iy, w: M.idleW, h: M.idleH });
      ix += M.idleW + M.idleGap;
    }
    bottom = iy + M.idleH + M.pad;
  }
  return { lanes, nodes, event, columns, links, idle, idleTitle, width, height: bottom };
}
