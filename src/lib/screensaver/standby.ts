// Pure logic of the standby card (v1.31): the screensaver layouts that fill a
// large terminal area — the server's clock, four rings, the history of the time
// away with what happened in it, a transfer under way. No DOM and no store:
// IdleOverlay.svelte paints, this decides, idle-standby tests pin it down.

import type { Threshold } from "../settings/settings.svelte";
import { thresholdLevel, type ThresholdLevel } from "../monitoring/thresholds";
import { loadHealth } from "../monitoring/monhealth";
import type { Problem } from "../monitoring/monproblems";
import { fmtUptime } from "../monitoring/format";
import { etaSeconds, transferPct, type TransferRow } from "../files/transfer";
import type { IdleSample } from "./idlefx";

// ── History of the time away (v1.34, ADR 0065) ──────────────────────────────
// Until v1.34 the history stretched the whole time away over the chart's width
// and merged neighbouring points pairwise as it grew: the scale changed on every
// poll, the line redrew itself at each merge, and a stretch nobody read was
// crossed by a straight line. Now one stream of readings feeds two views, each
// on a scale that holds still:
// - the charts — CPU, memory and load, each on a scale of its own — show the
//   last `CHART_MS` in buckets of one length aligned to the clock. A bucket keeps
//   the lowest, the highest and the mean of its readings: a spike survives as
//   the edge of the band while the line stays calm. The window slides right to
//   left; it never squeezes;
// - the strip shows the whole time away in cells aligned to the clock, each the
//   worst level a metric reached in it against the status bar's thresholds. A
//   cell keeps its length until the strip runs out of room; then neighbours
//   merge pairwise — a step, not a squeeze on every poll.
// A stretch vterm read nothing for is a gap: a failed poll, or no poll at all
// for longer than `gapMs` — a hidden window skips its polls, a sleeping computer
// makes none. The line breaks there, its cells stay empty and an open event
// closes: what was not seen is not drawn.

/** Which metric an event is about: the three charts. */
export type AwayKey = "cpu" | "mem" | "load";

/** A stretch of time one metric spent above its status-bar threshold. */
export interface AwayEvent {
  key: AwayKey;
  /** The worst level reached. */
  level: Exclude<ThresholdLevel, "ok">;
  start: number;
  end: number;
  /** Highest value seen: a percentage for CPU and memory, the load average for load. */
  peak: number;
  peakAt: number;
  /** The busiest process when the peak was read — empty when the host did not say. */
  top: string;
  /** Logical CPUs at the peak (load events only; null when unknown). */
  cores: number | null;
  /** Still going: the last sample was above the threshold too. */
  open: boolean;
}

/** One poll, as the overlay hands it over; `null` fields were not reported. */
export interface AwayReading {
  at: number;
  cpuPct: number | null;
  memPct: number | null;
  load1: number | null;
  cpuCount: number | null;
  topProc: string;
  memUsed: number | null;
  memTotal: number | null;
}

/** The thresholds an event is measured against (the status bar's own). */
export interface AwayThresholds {
  cpu?: Threshold;
  ram?: Threshold;
  load?: Threshold;
}

/** The lowest, the highest, the sum and the count of one metric's readings in a span: its band and its mean. */
export interface Agg {
  lo: number;
  hi: number;
  sum: number;
  n: number;
}

/** Why nothing was read before a span: a poll failed, or none was made for longer than a gap. */
export type GapKind = "failed" | "silent";

/** A stretch of the clock — a bucket of the charts or a cell of the strip — and what was read in it. */
export interface AwaySpan {
  /** Its start, wall-clock ms: a multiple of its length. */
  at: number;
  /** The first and the last reading in it. */
  first: number;
  last: number;
  /** Readings in it. */
  n: number;
  /** CPU and memory in percent, load as the load average reads. Null — not reported in it. */
  cpu: Agg | null;
  mem: Agg | null;
  load: Agg | null;
  /** The worst level each metric reached in it; null — not reported in it. */
  level: Record<AwayKey, ThresholdLevel | null>;
  /** Logical CPUs at the load peak, memory in bytes at the memory peak, the busiest process at the CPU peak. */
  cores: number | null;
  memUsed: number | null;
  memTotal: number | null;
  top: string;
  /** Nothing was read between the span before and this one's first reading — and why. */
  gapBefore: GapKind | null;
}

export interface AwayHistory {
  /** No reading for longer than this after the last entry is a gap, ms. */
  gapMs: number;
  /** The charts' buckets, `bucketMs` long: the last `CHART_MS` and the bucket before it. */
  bucketMs: number;
  buckets: AwaySpan[];
  /** The strip's cells, `step` long: the whole time away. */
  step: number;
  cells: AwaySpan[];
  events: AwayEvent[];
  /** When the first entry came — the history begins there; null before it. */
  firstAt: number | null;
  /** When the last entry came — a reading or a failed poll; null before the first. */
  lastAt: number | null;
  /** A gap since the last reading — and why: the next reading follows it. */
  pending: GapKind | null;
}

/** How far back the charts look, ms. */
export const CHART_MS = 30 * 60_000;
/** The shortest span, ms: every length is this one doubled again and again, so a span merges into the next length whole. */
export const SPAN_BASE_MS = 15_000;
/** The longest span, ms (about eleven days): the doubling stops there. */
export const SPAN_MAX_MS = SPAN_BASE_MS * 2 ** 16;
/** Cells the strip keeps before neighbours merge. */
export const STRIP_KEEP = 480;
/** How many events are kept: the oldest go first — the newest are the ones to see. */
export const AWAY_EVENTS = 50;

/** No reading for longer than this after the last one is a gap: three beats of the poll, never under the shortest span. */
export function gapAfter(beatMs: number): number {
  return Math.max(SPAN_BASE_MS, Number.isFinite(beatMs) && beatMs > 0 ? 3 * beatMs : 0);
}

/** The shortest span length of at least `ms`. */
export function spanLength(ms: number): number {
  let len = SPAN_BASE_MS;
  while (len < ms && len < SPAN_MAX_MS) len *= 2;
  return len;
}

/**
 * An empty history for a poll every `beatMs`. Spans are at least a gap long,
 * so between two readings that are not a gap apart no span is skipped: a span
 * with nothing in it is always a stretch nobody read.
 */
export function emptyAway(beatMs: number): AwayHistory {
  const gapMs = gapAfter(beatMs);
  const len = spanLength(gapMs);
  return { gapMs, bucketMs: len, buckets: [], step: len, cells: [], events: [], firstAt: null, lastAt: null, pending: null };
}

/** A reading the overlay could not take: every series unknown at `at`. */
export const gapReading = (at: number): AwayReading => ({
  at,
  cpuPct: null,
  memPct: null,
  load1: null,
  cpuCount: null,
  topProc: "",
  memUsed: null,
  memTotal: null,
});

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** A reading that read nothing — a failed poll. A host with no load average is not one: the rest was read. */
export const isGapReading = (r: AwayReading): boolean => !finite(r.cpuPct) && !finite(r.memPct) && !finite(r.load1);

/** Whether a reading at `at` comes after a silence: no entry for longer than `gapMs` since `lastAt`. */
export function silentSince(lastAt: number | null, at: number, gapMs: number): boolean {
  return lastAt != null && at - lastAt > gapMs;
}

/** The level a reading puts each metric at, or null for a metric it did not report. */
export function readingLevels(r: AwayReading, th: AwayThresholds): Record<AwayKey, ThresholdLevel | null> {
  const perCore = r.load1 != null && r.cpuCount != null && r.cpuCount > 0 ? r.load1 / r.cpuCount : null;
  return {
    cpu: r.cpuPct == null ? null : thresholdLevel(r.cpuPct, th.cpu),
    mem: r.memPct == null ? null : thresholdLevel(r.memPct, th.ram),
    load: r.load1 == null ? null : loadHealth(r.load1, perCore, th.load),
  };
}

const NO_LEVELS: Record<AwayKey, ThresholdLevel | null> = { cpu: null, mem: null, load: null };
const RANK: Record<ThresholdLevel, number> = { ok: 0, warn: 1, crit: 2 };

/** The worse of two levels; null is not known, so the other one wins. */
function worse<L extends ThresholdLevel>(a: L | null, b: L | null): L | null {
  if (a == null) return b;
  if (b == null) return a;
  return RANK[b] > RANK[a] ? b : a;
}

function addAgg(a: Agg | null, v: number | null): Agg | null {
  if (!finite(v)) return a;
  return a ? { lo: Math.min(a.lo, v), hi: Math.max(a.hi, v), sum: a.sum + v, n: a.n + 1 } : { lo: v, hi: v, sum: v, n: 1 };
}

function joinAgg(a: Agg | null, b: Agg | null): Agg | null {
  if (!a || !b) return a ?? b;
  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi), sum: a.sum + b.sum, n: a.n + b.n };
}

/** One reading as a span starting at `at`. */
function readingSpan(at: number, r: AwayReading, level: Record<AwayKey, ThresholdLevel | null>, gapBefore: GapKind | null): AwaySpan {
  return {
    at,
    first: r.at,
    last: r.at,
    n: 1,
    cpu: addAgg(null, r.cpuPct),
    mem: addAgg(null, r.memPct),
    load: addAgg(null, r.load1),
    level,
    cores: r.cpuCount,
    memUsed: r.memUsed,
    memTotal: r.memTotal,
    top: finite(r.cpuPct) ? r.topProc.trim() : "",
    gapBefore,
  };
}

/** Of two spans, the one whose `key` peaked higher — the first on a tie or when neither was read. */
const peakOf = (a: AwaySpan, b: AwaySpan, key: AwayKey): AwaySpan => ((b[key]?.hi ?? -Infinity) > (a[key]?.hi ?? -Infinity) ? b : a);

/**
 * Two spans as one starting at `at`, `b` after `a`. What a span says beside its
 * values comes from the span that gave the peak: the process from the higher
 * CPU, the bytes from the higher memory, the cores from the higher load. A gap
 * between the two is inside the joined span — below what it can show.
 */
function joinSpans(a: AwaySpan, b: AwaySpan, at = a.at): AwaySpan {
  const byLoad = peakOf(a, b, "load");
  const byMem = peakOf(a, b, "mem");
  return {
    at,
    first: Math.min(a.first, b.first),
    last: Math.max(a.last, b.last),
    n: a.n + b.n,
    cpu: joinAgg(a.cpu, b.cpu),
    mem: joinAgg(a.mem, b.mem),
    load: joinAgg(a.load, b.load),
    level: { cpu: worse(a.level.cpu, b.level.cpu), mem: worse(a.level.mem, b.level.mem), load: worse(a.level.load, b.level.load) },
    cores: byLoad.cores,
    memUsed: byMem.memUsed,
    memTotal: byMem.memTotal,
    top: peakOf(a, b, "cpu").top,
    gapBefore: a.gapBefore,
  };
}

/** `spans` with a reading added to the `len`-long span it falls in — a new one at the end, or the last one. */
function addReading(
  spans: readonly AwaySpan[],
  r: AwayReading,
  level: Record<AwayKey, ThresholdLevel | null>,
  len: number,
  gapBefore: GapKind | null,
): AwaySpan[] {
  const at = Math.floor(r.at / len) * len;
  const last = spans[spans.length - 1];
  if (last && last.at >= at) return [...spans.slice(0, -1), joinSpans(last, readingSpan(last.at, r, level, null))];
  return [...spans, readingSpan(at, r, level, gapBefore)];
}

/** `spans` (in time order) merged into spans `len` long: each falls into the one that holds its start. */
export function mergeSpans(spans: readonly AwaySpan[], len: number): AwaySpan[] {
  const out: AwaySpan[] = [];
  for (const s of spans) {
    const at = Math.floor(s.at / len) * len;
    const last = out[out.length - 1];
    if (last && last.at === at) out[out.length - 1] = joinSpans(last, s, at);
    else out.push({ ...s, at });
  }
  return out;
}

/**
 * The events after one more reading: each metric above its threshold opens an
 * event or extends its open one, and a metric back at ok — or not reported —
 * closes it: a stretch vterm did not see is not claimed to have gone on.
 */
function nextEvents(events: readonly AwayEvent[], r: AwayReading, levels: Record<AwayKey, ThresholdLevel | null>): AwayEvent[] {
  const value: Record<AwayKey, number | null> = { cpu: r.cpuPct, mem: r.memPct, load: r.load1 };
  const out = events.map((e) => ({ ...e }));
  for (const key of ["cpu", "mem", "load"] as const) {
    const level = levels[key];
    const v = value[key];
    let open: AwayEvent | undefined;
    for (let i = out.length - 1; i >= 0 && !open; i--) if (out[i].key === key && out[i].open) open = out[i];
    if (level == null || level === "ok" || v == null) {
      if (open) open.open = false;
      continue;
    }
    const top = key === "mem" ? "" : r.topProc.trim();
    const cores = key === "load" ? r.cpuCount : null;
    if (open) {
      open.end = r.at;
      open.level = worse(open.level, level) ?? level;
      if (v > open.peak) Object.assign(open, { peak: v, peakAt: r.at, top, cores });
    } else {
      out.push({ key, level, start: r.at, end: r.at, peak: v, peakAt: r.at, top, cores, open: true });
    }
  }
  return out.slice(-AWAY_EVENTS);
}

/**
 * The history after one more poll. A reading after a silence longer than a gap
 * follows that gap: the open events close first. A failed poll is a gap of its
 * own. A reading joins its bucket and its cell; buckets older than the charts
 * reach are let go, and cells past `STRIP_KEEP` merge pairwise into the next
 * length. The clock may step back (a time sync): a reading is never placed
 * before the last entry.
 */
export function awayPush(h: AwayHistory, reading: AwayReading, th: AwayThresholds): AwayHistory {
  const r = h.lastAt != null && reading.at < h.lastAt ? { ...reading, at: h.lastAt } : reading;
  const silent = silentSince(h.lastAt, r.at, h.gapMs);
  const failed = isGapReading(r);
  const pending = h.pending ?? (silent ? "silent" : failed ? "failed" : null);
  const seen = silent ? nextEvents(h.events, gapReading(r.at), NO_LEVELS) : h.events;
  const firstAt = h.firstAt ?? r.at;
  if (failed) return { ...h, events: nextEvents(seen, r, NO_LEVELS), firstAt, lastAt: r.at, pending };
  const levels = readingLevels(r, th);
  const buckets = addReading(h.buckets, r, levels, h.bucketMs, pending).filter(
    (b) => b.at + 2 * h.bucketMs > r.at - CHART_MS,
  );
  let step = h.step;
  let cells = addReading(h.cells, r, levels, step, pending);
  while (cells.length > STRIP_KEEP && step < SPAN_MAX_MS) {
    step *= 2;
    cells = mergeSpans(cells, step);
  }
  return { ...h, buckets, cells, step, events: nextEvents(seen, r, levels), firstAt, lastAt: r.at, pending: null };
}

// ── The charts ───────────────────────────────────────────────────────────────

/** The left edge of the charts whose right edge stands at `to`. */
export const chartFrom = (to: number): number => to - CHART_MS;

/** Where a span stands on a chart: the middle of its readings. */
export const spanMid = (s: Pick<AwaySpan, "first" | "last">): number => (s.first + s.last) / 2;

/** One point of a chart: a span's mean of one metric with its band, at the span's middle. */
export interface BandPoint {
  at: number;
  mean: number;
  lo: number;
  hi: number;
}

/**
 * One metric's chart over `len`-long spans: runs of points, broken where nothing
 * was read — between spans that do not follow each other, before a span that
 * follows a gap — and where the metric itself was not reported.
 */
export function bandRuns(spans: readonly AwaySpan[], key: AwayKey, len: number): BandPoint[][] {
  const runs: BandPoint[][] = [];
  let run: BandPoint[] = [];
  let prev: AwaySpan | null = null;
  for (const s of spans) {
    const a = s[key];
    const broken = !a || (prev != null && (s.gapBefore != null || s.at - prev.at > len));
    if (broken && run.length) {
      runs.push(run);
      run = [];
    }
    if (a) run.push({ at: spanMid(s), mean: a.sum / a.n, lo: a.lo, hi: a.hi });
    prev = s;
  }
  if (run.length) runs.push(run);
  return runs;
}

/** The highest reading of `key` in the spans that reach past `from`, or null when none was read. */
export function windowPeak(spans: readonly AwaySpan[], key: AwayKey, from: number): number | null {
  let peak: number | null = null;
  for (const s of spans) {
    const a = s[key];
    if (a && s.last >= from) peak = peak == null ? a.hi : Math.max(peak, a.hi);
  }
  return peak;
}

/**
 * The top of the load chart: the cores or the highest load in sight, whichever
 * is higher, with room above it, rounded to a step that reads well. Load past
 * the cores is drawn as it was, not cut at them.
 */
export function loadCeiling(peak: number | null, cores: number | null): number {
  const top = Math.max(1, finite(peak) ? peak : 0, cores != null && cores > 0 ? cores : 0) * 1.15;
  const unit = top <= 4 ? 1 : top <= 20 ? 2 : top <= 50 ? 5 : 10;
  return Math.ceil(top / unit) * unit;
}

/** A stretch nothing was read in: from the last reading before it to the first after it (or the last poll), and why. */
export interface AwayGap {
  from: number;
  to: number;
  kind: GapKind;
}

/**
 * The stretches of `len`-long `spans` nothing was read in — and, while the
 * history waits for a reading after a gap (`pending`), the one from its last
 * reading up to the last poll (`lastAt`).
 */
export function awayGaps(spans: readonly AwaySpan[], len: number, pending: GapKind | null, lastAt: number | null): AwayGap[] {
  const out: AwayGap[] = [];
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1];
    const b = spans[i];
    if (b.gapBefore != null || b.at - a.at > len) out.push({ from: a.last, to: b.first, kind: b.gapBefore ?? "silent" });
  }
  const last = spans[spans.length - 1];
  if (pending && last && lastAt != null && lastAt > last.last) out.push({ from: last.last, to: lastAt, kind: pending });
  return out;
}

/** What the pointer is over on a chart: a span (its index), or a gap. */
export type ChartHit = { span: number } | { gap: AwayGap };

/**
 * What is at time `at` on a chart drawn over `from…to`: the gap it falls in, or
 * else the span in sight nearest to it — or nothing, before the first reading.
 */
export function chartHit(spans: readonly AwaySpan[], gaps: readonly AwayGap[], at: number, from: number, to: number): ChartHit | null {
  if (!Number.isFinite(at)) return null;
  for (const gap of gaps) if (at > gap.from && at < gap.to) return { gap };
  let best = -1;
  let dist = Infinity;
  spans.forEach((s, i) => {
    const mid = spanMid(s);
    if (mid < from - (s.last - s.first) || mid > to) return;
    const d = Math.abs(mid - at);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best < 0 ? null : { span: best };
}

// ── The strip ────────────────────────────────────────────────────────────────

/** The strip as drawn: cells `step` long, `count` of them from `from` up to the right edge. */
export interface StripView {
  step: number;
  count: number;
  from: number;
  cells: AwaySpan[];
}

/**
 * The strip of `count` cells whose right edge stands at `to`, the time away
 * beginning at `leftAt`: the history's own cells, merged into longer ones until
 * the whole time away fits. The length steps up only when the time away
 * outgrows the strip, so between steps the cells hold still and slide.
 */
export function stripView(cells: readonly AwaySpan[], step: number, leftAt: number, to: number, count: number): StripView {
  const n = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  let len = Math.max(SPAN_BASE_MS, step);
  let out: AwaySpan[] = [...cells];
  while ((to - leftAt) / len > n && len < SPAN_MAX_MS) {
    len *= 2;
    out = mergeSpans(out, len);
  }
  const from = to - n * len;
  return { step: len, count: n, from, cells: out.filter((c) => c.at + len > from) };
}

/** One slot of the strip from the time away's start to its right edge: the cell read there, or null — nothing was. */
export interface StripSlot {
  at: number;
  cell: AwaySpan | null;
}

/** The slots of `view` from the time away's start (`leftAt`) up to `to`, oldest first. */
export function stripSlots(view: StripView, leftAt: number, to: number): StripSlot[] {
  const byAt = new Map(view.cells.map((c) => [c.at, c]));
  const out: StripSlot[] = [];
  for (let at = Math.floor(Math.max(leftAt, view.from) / view.step) * view.step; at < to; at += view.step) {
    out.push({ at, cell: byAt.get(at) ?? null });
  }
  return out;
}

/** The x of the start of a slot at `at` on a strip `gw` wide from `gx`. */
export function stripX(view: StripView, at: number, gx: number, gw: number): number {
  return gx + ((at - view.from) / (view.count * view.step)) * gw;
}

/** The slot under `x` on a strip `gw` wide from `gx` (its index in `slots`), or -1 — none, or off the strip. */
export function stripHit(slots: readonly StripSlot[], view: StripView, x: number, gx: number, gw: number): number {
  if (!Number.isFinite(x) || x < gx - HOVER_SLACK || x > gx + gw + HOVER_SLACK || !(gw > 0)) return -1;
  const span = view.count * view.step;
  // The right edge itself belongs to the last slot, not to the one after it.
  const at = view.from + Math.min(span - 1, ((Math.min(gx + gw, Math.max(gx, x)) - gx) / gw) * span);
  const slot = Math.floor(at / view.step) * view.step;
  return slots.findIndex((s) => s.at === slot);
}

/** Why nothing was read in the unread slot `i`: the gap the next cell read follows, else the one still waiting. */
export function slotGap(slots: readonly StripSlot[], i: number, pending: GapKind | null): GapKind {
  for (let j = i + 1; j < slots.length; j++) {
    const cell = slots[j].cell;
    if (cell) return cell.gapBefore ?? "silent";
  }
  return pending ?? "silent";
}

// ── How the history lays itself out ──────────────────────────────────────────

/** Where the parts of the history stand in a block `h` px high, from its top. */
export interface HistoryLayout {
  /** The tops of the three charts and their height. */
  rowY: [number, number, number];
  rowH: number;
  /** The time axis under the charts. */
  axisY: number;
  /** The strip's title, its rows of cells (three — a row a metric — or one: the worst of the three), their height and step. */
  stripY: number;
  stripRows: 1 | 3;
  cellY: number;
  cellH: number;
  cellStep: number;
  /** The times under the cells. */
  stripLabelY: number;
}

const LAYOUT = {
  big: { rowGap: 16, axisH: 24, sep: 18, titleH: 24, cellH: 8, cellGap: 5, labelsH: 20, minRow: 44 },
  small: { rowGap: 10, axisH: 18, sep: 10, titleH: 17, cellH: 6, cellGap: 3, labelsH: 15, minRow: 24 },
} as const;

/**
 * The history in a block `h` px high: three charts, the time axis, the strip.
 * The strip takes a row a metric while the charts keep a height worth reading;
 * in a lower block it takes one row — the worst of the three — and the charts
 * get the rest.
 */
export function historyLayout(h: number, big: boolean): HistoryLayout {
  const L = big ? LAYOUT.big : LAYOUT.small;
  const stripH = (rows: number) => L.titleH + rows * L.cellH + (rows - 1) * L.cellGap + L.labelsH;
  const rowsFor = (rows: number) => (h - 2 * L.rowGap - L.axisH - L.sep - stripH(rows)) / 3;
  const stripRows: 1 | 3 = rowsFor(3) >= L.minRow ? 3 : 1;
  const rowH = Math.max(8, Math.floor(rowsFor(stripRows)));
  const axisY = 3 * rowH + 2 * L.rowGap;
  const stripY = axisY + L.axisH + L.sep;
  const cellY = stripY + L.titleH;
  return {
    rowY: [0, rowH + L.rowGap, 2 * (rowH + L.rowGap)],
    rowH,
    axisY,
    stripY,
    stripRows,
    cellY,
    cellH: L.cellH,
    cellStep: L.cellH + L.cellGap,
    stripLabelY: cellY + stripRows * L.cellH + (stripRows - 1) * L.cellGap + 4,
  };
}

// ── Time on an axis ──────────────────────────────────────────────────────────

/**
 * Canvas points of one series across a `w × h` box at (`x0`, `y0`), placed by
 * TIME over `from…to`, fraction 1 at the top edge — the small cards' chart.
 * Split into runs at unknown points, so a gap is drawn as a gap. The edges of a
 * chart move smoothly to a new reading (v1.33), so the line crosses them: it is
 * cut at each edge, at the value between the last point inside and the first
 * outside — never drawn past the box.
 */
export function timeRuns(
  points: readonly ({ at: number } & IdleSample)[],
  key: keyof IdleSample,
  from: number,
  to: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): { x: number; y: number }[][] {
  const span = to - from;
  const xAt = (at: number) => (span > 0 ? x0 + ((at - from) / span) * w : x0);
  const yAt = (v: number) => y0 + h - Math.min(1, Math.max(0, v)) * h;
  // The value between two points at time `at` (inside their stretch).
  const between = (a: { at: number; v: number }, b: { at: number; v: number }, at: number) =>
    yAt(a.v + ((b.v - a.v) * (at - a.at)) / (b.at - a.at));
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  let prev: { at: number; v: number } | null = null;
  for (const pt of points) {
    const v = pt[key];
    if (v == null) {
      if (run.length) runs.push(run);
      run = [];
      prev = null;
      continue;
    }
    const cur = { at: pt.at, v };
    if (pt.at < from) {
      prev = cur;
      continue;
    }
    if (prev && prev.at < from && pt.at > from) run.push({ x: x0, y: between(prev, cur, from) });
    if (pt.at > to) {
      if (prev && prev.at < to && run.length) run.push({ x: xAt(to), y: between(prev, cur, to) });
      break;
    }
    run.push({ x: xAt(pt.at), y: yAt(v) });
    prev = cur;
  }
  if (run.length) runs.push(run);
  return runs;
}

/** The x of wall-clock time `at` on a `from…to` axis of width `w` starting at `x0`. */
export function timeX(at: number, from: number, to: number, x0: number, w: number): number {
  return to > from ? x0 + ((at - from) / (to - from)) * w : x0;
}

// ── Under the pointer ────────────────────────────────────────────────────────
// The charts carry no marks of their own (v1.33): every event drew a dashed line
// and a dot, and a busy stretch became a fence nobody could read. What happened
// at a moment is told by a tooltip over what is under the pointer: a bucket of
// the charts, a cell of the strip, or a stretch vterm read nothing for. A
// pointer that rests stops showing it — a tooltip left up for hours would hold
// its pixels lit like any other.

/** How far past a chart's sides, px, the pointer still picks what is at the end. */
export const HOVER_SLACK = 12;
/** A pointer that has not moved for this long, ms, shows no tooltip. */
export const HOVER_STILL_MS = 10_000;

/** Whether a pointer last moved at `movedAt` (null — not over the screensaver) still shows a tooltip at `now`. */
export function hoverShown(movedAt: number | null, now: number): boolean {
  return movedAt != null && now - movedAt >= 0 && now - movedAt < HOVER_STILL_MS;
}

/** The time under `x` on a `from…to` axis `gw` wide from `gx`, or null — off it by more than `HOVER_SLACK`. */
export function timeAtX(x: number, from: number, to: number, gx: number, gw: number): number | null {
  if (!Number.isFinite(x) || x < gx - HOVER_SLACK || x > gx + gw + HOVER_SLACK || !(gw > 0) || !(to > from)) return null;
  return from + ((Math.min(gx + gw, Math.max(gx, x)) - gx) / gw) * (to - from);
}

const KEY_ORDER: Record<AwayKey, number> = { cpu: 0, mem: 1, load: 2 };

/** The events whose stretch shares time with `from…to`: CPU, then memory, then load. */
export function eventsAt(events: readonly AwayEvent[], from: number, to: number): AwayEvent[] {
  return events
    .filter((e) => e.start <= to && e.end >= from)
    .sort((a, b) => KEY_ORDER[a.key] - KEY_ORDER[b.key] || a.start - b.start);
}

/** A stretch of time, short: seconds under a minute, else as the uptime reads ("6m", "1h 2m", "2d 3h"). */
export function spanLabel(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  return s < 60 ? `${s}s` : fmtUptime(s);
}

// ── Above the charts (v1.34, ADR 0065) ───────────────────────────────────────
// Four rings over the charts told CPU, memory and load a second time. Each
// metric now has one place — a small ring at the start of its own chart — and
// the room above tells what the charts do not: how the host is now, by the
// status bar's own verdict (`barProblems`), and its disk, swap, network and
// temperature, all from the same basic probe.

/** Swap as the host reports it: the share used, "none" — the host has no swap, null — not reported. */
export function swapShare(used: number | null, total: number | null): number | "none" | null {
  if (total == null || !Number.isFinite(total)) return null;
  if (total <= 0) return "none";
  if (used == null || !Number.isFinite(used)) return null;
  return Math.min(1, Math.max(0, used / total));
}

/** The smallest ring worth drawing at the start of a chart, px; below it the value is told as text. */
export const GUTTER_RING_MIN = 13;

/** The radius of the ring at the start of a chart `rowH` high, or null — too low for one. */
export function gutterRing(rowH: number, big: boolean): number | null {
  const r = Math.min(big ? 30 : 22, Math.floor((Number.isFinite(rowH) ? rowH : 0) / 2) - 1);
  return r >= GUTTER_RING_MIN ? r : null;
}

/** The verdict line above the charts: nothing read yet, all OK, or the worst problem and how many more there are. */
export type VerdictLine = { kind: "none" } | { kind: "ok" } | { kind: "problem"; problem: Problem; more: number };

/** The verdict line for the newest reading (`read` — one came back) and the problems the status bar sees in it. */
export function verdictLine(read: boolean, ps: readonly Problem[]): VerdictLine {
  if (!read) return { kind: "none" };
  if (!ps.length) return { kind: "ok" };
  const worst = ps.find((p) => p.level === "crit") ?? ps[0];
  return { kind: "problem", problem: worst, more: ps.length - 1 };
}

// ── The server's clock ───────────────────────────────────────────────────────
// The probe reports the server's wall clock as "HH:MM ZONE" once a tick. Its
// difference from this machine's clock — rounded to the quarter hour every
// time zone is a multiple of — lets the card run the server's clock live. A
// host that does not say (a local tab, a probe without `date`) has no offset:
// the card shows this machine's time and says so.

/** The server clock's lead over this machine's, in minutes, or null when `serverTime` does not say. */
export function serverOffset(serverTime: string, localAt: number): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\b/.exec(serverTime);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(localAt);
  let diff = h * 60 + min - (d.getHours() * 60 + d.getMinutes());
  if (diff > 720) diff -= 1440;
  if (diff <= -720) diff += 1440;
  return Math.round(diff / 15) * 15;
}

/** The zone the server named after its time ("UTC", "MSK"), or "". */
export function serverZone(serverTime: string): string {
  return /^\s*\d{1,2}:\d{2}\s+(\S+)/.exec(serverTime)?.[1] ?? "";
}

/** The wall-clock time `at` reads on a clock `offsetMin` minutes ahead of this one. */
export const shifted = (at: number, offsetMin: number): Date => new Date(at + offsetMin * 60_000);

/** "HH:MM" of `at` on a clock `offsetMin` minutes ahead. */
export function clockLabel(at: number, offsetMin: number): string {
  const d = shifted(at, offsetMin);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Tick steps of the time axis, minutes. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720];

/**
 * Ticks of a `from…to` time axis on the server's clock: at whole minutes of a
 * round step, as few steps as keep the count at or under `maxTicks`. Returns
 * this machine's wall-clock times, ready for `timeX`.
 */
export function timeTicks(from: number, to: number, offsetMin: number, maxTicks: number): number[] {
  if (!(to > from) || maxTicks < 1) return [];
  const spanMin = (to - from) / 60_000;
  const step = TICK_STEPS.find((s) => spanMin / s <= maxTicks) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const d = shifted(from, offsetMin);
  const minutes = d.getHours() * 60 + d.getMinutes() + (d.getSeconds() || d.getMilliseconds() ? 1 : 0);
  d.setHours(0, Math.ceil(minutes / step) * step, 0, 0);
  const out: number[] = [];
  for (let at = d.getTime() - offsetMin * 60_000; at <= to && out.length < maxTicks; at += step * 60_000) {
    out.push(at);
  }
  return out;
}

// ── A transfer under way ─────────────────────────────────────────────────────
// A transfer moves no terminal output, so the screensaver can rise over one:
// the card shows how it goes. Its speed and time left are the transfer store's
// own (measured between progress events) — unknown until there is a window to
// measure, and then shown as unknown.

export interface StandbyTransfer {
  row: TransferRow;
  pct: number;
  /** Bytes per second, or null while not yet measured. */
  rate: number | null;
  /** Seconds left, or null while unknowable. */
  eta: number | null;
  /** Other transfers under way. */
  more: number;
}

/** The transfer to show: the first one still running, with how many others run beside it. */
export function standbyTransfer(
  rows: readonly TransferRow[],
  rates: Readonly<Record<string, number | null>>,
): StandbyTransfer | null {
  const running = rows.filter((r) => !r.done);
  const row = running[0];
  if (!row) return null;
  const rate = rates[row.id] ?? null;
  return {
    row,
    pct: transferPct(row.transferred, row.total),
    rate,
    eta: etaSeconds(row.transferred, row.total, rate),
    more: running.length - 1,
  };
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** The ring's fill 0…1 for a value against its ceiling, or null when either is unknown. */
export function ringFraction(value: number | null, ceiling: number | null): number | null {
  if (value == null || ceiling == null || !Number.isFinite(value) || !(ceiling > 0)) return null;
  return Math.min(1, Math.max(0, value / ceiling));
}

// ── Burn-in ──────────────────────────────────────────────────────────────────
// A card left up for hours would hold the same pixels lit. When the user asks
// for it, the whole layout shifts instead: every chosen interval it steps, by
// whole pixels, to the next point of a Lissajous path a few pixels wide — so no
// pixel keeps one colour for hours. The steps are small (a couple of pixels) and
// the path does not retrace itself soon. The prod frame does not move: it marks
// the area's edge.

/** Largest shift, px. */
export const DRIFT_X = 10;
export const DRIFT_Y = 8;
/** Periods of the path's two axes, seconds of path — unequal, so it does not retrace itself. */
export const DRIFT_PERIOD_X = 360;
export const DRIFT_PERIOD_Y = 250;
/** Seconds of path between two positions: one shift moves the layout a couple of pixels. */
export const SHIFT_PATH_STEP = 12;

/** The point of the path `ms` of path in. */
export function driftOffset(ms: number): { dx: number; dy: number } {
  const s = Number.isFinite(ms) ? ms / 1000 : 0;
  return {
    dx: DRIFT_X * Math.sin((2 * Math.PI * s) / DRIFT_PERIOD_X),
    dy: DRIFT_Y * Math.sin((2 * Math.PI * s) / DRIFT_PERIOD_Y),
  };
}

/**
 * The layout's offset `ms` after the screensaver rose when it shifts every
 * `everySec` seconds: in place until the first shift, then a whole-pixel step
 * along the path each interval. Off (`null`) — it never moves.
 */
export function shiftOffset(ms: number, everySec: number | null): { dx: number; dy: number } {
  if (everySec == null || !(everySec > 0) || !Number.isFinite(ms) || ms < 0) return { dx: 0, dy: 0 };
  const step = Math.floor(ms / (everySec * 1000));
  const { dx, dy } = driftOffset(step * SHIFT_PATH_STEP * 1000);
  // `+ 0` turns a rounded -0 into 0.
  return { dx: Math.round(dx) + 0, dy: Math.round(dy) + 0 };
}
