// Pure logic of the standby card (v1.31): the screensaver layouts that fill a
// large terminal area. Since ADR 0075 they are calm: the server's clock, the
// host and the status bar's verdict, one line — the pulse — over the last half
// hour, four quiet numbers under it, one sentence about the time away and a
// transfer under way. No DOM and no store: IdleOverlay.svelte paints, this
// decides, the standby tests pin it down.

import type { Threshold } from "../settings/settings.svelte";
import { thresholdLevel, type ThresholdLevel } from "../monitoring/thresholds";
import { loadHealth } from "../monitoring/monhealth";
import type { Problem } from "../monitoring/monproblems";
import { fmtUptime } from "../monitoring/format";
import { etaSeconds, transferPct, type TransferRow } from "../files/transfer";
import type { IdleSample } from "./idlefx";

// ── History of the time away (v1.34, ADR 0065; ADR 0075) ────────────────────
// One stream of readings, told two ways, each on a scale that holds still:
// - the pulse — one metric's line over the last `CHART_MS` in buckets of one
//   length aligned to the clock. A bucket keeps the lowest, the highest and the
//   mean of its readings; the line is the mean. The window slides right to
//   left; it never squeezes (ADR 0065);
// - the sentence — the whole time away in words (`awayStory`): a restart of the
//   server, a metric over its threshold, the longest stretch nothing was read,
//   or that nothing happened. The strip of cells that told it before (ADR 0065)
//   went with the dashboard it belonged to (ADR 0075).
// A stretch vterm read nothing for is a gap: a failed poll, or no poll at all
// for longer than `gapMs` — a hidden window skips its polls, a sleeping computer
// makes none. The line breaks there and an open event closes: what was not
// seen is not drawn.

/** Which metric an event is about: the ones the pulse can draw. */
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
  /** How long the host has been up, seconds: when it booted, so a restart while away is told. */
  uptimeSecs: number | null;
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

/** A stretch of the clock — a bucket of the pulse — and what was read in it. */
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
  /** The pulse's buckets, `bucketMs` long: the last `CHART_MS` and the bucket before it. */
  bucketMs: number;
  buckets: AwaySpan[];
  events: AwayEvent[];
  /** When the first entry came — the history begins there; null before it. */
  firstAt: number | null;
  /** When the last entry came — a reading or a failed poll; null before the first. */
  lastAt: number | null;
  /** When the last reading that read something came; null before the first. */
  lastReadAt: number | null;
  /** A gap since the last reading — and why: the next reading follows it. */
  pending: GapKind | null;
  /** The longest stretch of the whole time away nothing was read in, once a reading followed it; null — none yet. */
  longestGap: AwayGap | null;
  /** When the host booted, by its newest reading; null — it did not say. */
  bootAt: number | null;
  /** When it booted again while watched — a restart between two readings; null — none. */
  rebootAt: number | null;
}

/** How far back the pulse looks, ms. */
export const CHART_MS = 30 * 60_000;
/** The shortest span, ms: every length is this one doubled again and again. */
export const SPAN_BASE_MS = 15_000;
/** The longest span, ms (about eleven days): the doubling stops there. */
export const SPAN_MAX_MS = SPAN_BASE_MS * 2 ** 16;
/** How many events are kept: the oldest go first — the newest are the ones to see. */
export const AWAY_EVENTS = 50;
/**
 * A boot time that moved later by more than this is a restart, ms. The boot
 * time is the reading's time less the uptime, and both wobble by the poll's own
 * latency — seconds, never a minute.
 */
export const REBOOT_SLACK_MS = 60_000;
/** The shortest stretch nothing was read in that the sentence about the time away names, ms. */
export const STORY_GAP_MS = 60_000;

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
  return {
    gapMs,
    bucketMs: spanLength(gapMs),
    buckets: [],
    events: [],
    firstAt: null,
    lastAt: null,
    lastReadAt: null,
    pending: null,
    longestGap: null,
    bootAt: null,
    rebootAt: null,
  };
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
  uptimeSecs: null,
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
 * Two spans as one starting at `a.at`, `b` after `a`. What a span says beside
 * its values comes from the span that gave the peak: the process from the
 * higher CPU, the bytes from the higher memory, the cores from the higher load.
 */
function joinSpans(a: AwaySpan, b: AwaySpan): AwaySpan {
  const byLoad = peakOf(a, b, "load");
  const byMem = peakOf(a, b, "mem");
  return {
    at: a.at,
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

/** The longer of two stretches; the first on a tie, either when the other is missing. */
function longer(a: AwayGap | null, b: AwayGap | null): AwayGap | null {
  if (!a || !b) return a ?? b;
  return b.to - b.from > a.to - a.from ? b : a;
}

/**
 * The history after one more poll. A reading after a silence longer than a gap
 * follows that gap: the open events close first, and the gap is measured for
 * the sentence. A failed poll is a gap of its own. A reading joins its bucket;
 * buckets older than the pulse reaches are let go. A boot time later than the
 * last one is a restart. The clock may step back (a time sync): a reading is
 * never placed before the last entry.
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
  const gap: AwayGap | null = pending && h.lastReadAt != null ? { from: h.lastReadAt, to: r.at, kind: pending } : null;
  const bootAt = finite(r.uptimeSecs) && r.uptimeSecs >= 0 ? r.at - r.uptimeSecs * 1000 : h.bootAt;
  const restarted = h.bootAt != null && bootAt != null && bootAt - h.bootAt > REBOOT_SLACK_MS;
  return {
    ...h,
    buckets,
    events: nextEvents(seen, r, levels),
    firstAt,
    lastAt: r.at,
    lastReadAt: r.at,
    pending: null,
    longestGap: longer(h.longestGap, gap),
    bootAt,
    rebootAt: restarted ? bootAt : h.rebootAt,
  };
}

// ── The pulse ────────────────────────────────────────────────────────────────

/** The left edge of the pulse whose right edge stands at `to`. */
export const chartFrom = (to: number): number => to - CHART_MS;

/** Where a span stands on the pulse: the middle of its readings. */
export const spanMid = (s: Pick<AwaySpan, "first" | "last">): number => (s.first + s.last) / 2;

/** One point of the pulse: a span's mean of one metric with its band, at the span's middle. */
export interface BandPoint {
  at: number;
  mean: number;
  lo: number;
  hi: number;
}

/**
 * One metric's line over `len`-long spans: runs of points, broken where nothing
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
 * The top of the load pulse: the cores or the highest load in sight, whichever
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

/** What the pointer is over on the pulse: a span (its index), or a gap. */
export type ChartHit = { span: number } | { gap: AwayGap };

/**
 * What is at time `at` on a pulse drawn over `from…to`: the gap it falls in, or
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

/** Which metric the pulse draws, and how it stands by the status bar. */
export interface PulseOf {
  key: AwayKey;
  level: ThresholdLevel;
}

/** The status bar's problems that name a metric the pulse can draw. */
const PULSE_OF: Readonly<Record<string, AwayKey>> = { cpu: "cpu", ram: "mem", load: "load" };

/**
 * The metric the pulse draws (ADR 0075): the first of the status bar's
 * problems — the critical first, then in section order — that is about CPU,
 * memory or load, at that problem's level; CPU at ok while none is.
 */
export function pulseOf(ps: readonly Problem[]): PulseOf {
  for (const p of ps) {
    const key = PULSE_OF[p.id];
    if (key) return { key, level: p.level };
  }
  return { key: "cpu", level: "ok" };
}

/**
 * The one event marked on the pulse: the highest peak of its metric inside
 * `from…to`, or null. A mark per event made the line a fence nobody could read
 * (v1.33); the rest is the tooltip's and the sentence's.
 */
export function pulseMark(events: readonly AwayEvent[], key: AwayKey, from: number, to: number): AwayEvent | null {
  let best: AwayEvent | null = null;
  for (const e of events) {
    if (e.key === key && e.peakAt >= from && e.peakAt <= to && (!best || e.peak > best.peak)) best = e;
  }
  return best;
}

// ── The sentence about the time away (ADR 0075) ─────────────────────────────

/**
 * The time away in one sentence's worth: the first that applies of a restart,
 * a metric still over its threshold, the highest peak, the longest stretch
 * nothing was read in — or that nothing happened. `more` — the other events
 * beside the one told. `none` — nothing read yet, nothing to say.
 */
export type AwayStory =
  | { kind: "none" }
  | { kind: "calm" }
  | { kind: "reboot"; at: number; more: number }
  | { kind: "open"; event: AwayEvent; more: number }
  | { kind: "peak"; event: AwayEvent; more: number }
  | { kind: "gap"; gap: AwayGap };

/**
 * How high an event went, comparable across metrics: CPU and memory in
 * percent, load in percent of the cores. Load with the cores unknown is not
 * comparable: it ranks last among its level.
 */
export function eventHeight(e: AwayEvent): number {
  if (e.key !== "load") return e.peak;
  return e.cores != null && e.cores > 0 ? (e.peak / e.cores) * 100 : 0;
}

/** The worse event first: by level, then by height, then the later one. */
const byWeight = (a: AwayEvent, b: AwayEvent): number =>
  RANK[b.level] - RANK[a.level] || eventHeight(b) - eventHeight(a) || b.end - a.end;

/** The gap still open — from the last reading to the last poll — or null. */
export function openGap(h: AwayHistory): AwayGap | null {
  return h.pending && h.lastReadAt != null && h.lastAt != null && h.lastAt > h.lastReadAt
    ? { from: h.lastReadAt, to: h.lastAt, kind: h.pending }
    : null;
}

/**
 * When the host restarted while the user was away (`leftAt`): between two
 * readings, or before the first one — it booted after the user left. Null — it
 * did not, or it never said how long it had been up.
 */
export function restartedAt(h: AwayHistory, leftAt: number): number | null {
  if (h.rebootAt != null) return h.rebootAt;
  return h.bootAt != null && Number.isFinite(leftAt) && h.bootAt - leftAt > REBOOT_SLACK_MS ? h.bootAt : null;
}

/** The sentence about the time away since `leftAt`, by the history read so far. */
export function awayStory(h: AwayHistory, leftAt: number): AwayStory {
  if (h.firstAt == null) return { kind: "none" };
  const events = h.events;
  const restart = restartedAt(h, leftAt);
  if (restart != null) return { kind: "reboot", at: restart, more: events.length };
  const ranked = [...events].sort(byWeight);
  const open = ranked.find((e) => e.open);
  if (open) return { kind: "open", event: open, more: events.length - 1 };
  if (ranked[0]) return { kind: "peak", event: ranked[0], more: events.length - 1 };
  const gap = longer(h.longestGap, openGap(h));
  if (gap && gap.to - gap.from >= STORY_GAP_MS) return { kind: "gap", gap };
  return { kind: "calm" };
}

/** The process's name from the probe's "name pct%": what the sentence and the mark say. */
export function procName(top: string): string {
  return top.trim().split(/\s+/)[0] ?? "";
}

// ── How the standby screen lays itself out (ADR 0075) ────────────────────────

/** Where everything of the standby screen stands in a `W × H` area, px from its top-left. */
export interface PulseLayout {
  /** The side margin. */
  pad: number;
  /** The clock's top and size; the date line under it; "your time" under that. */
  clockY: number;
  clockSize: number;
  dateY: number;
  dateSize: number;
  yourTimeY: number;
  /** Small text: "your time", the times under the pulse, the gap's note. */
  smallSize: number;
  /** The host's line (set flush right) and the verdict under it. */
  hostY: number;
  hostSize: number;
  verdictY: number;
  verdictSize: number;
  /** The pulse's heading: the metric on the left, the sentence on the right. */
  headY: number;
  headSize: number;
  /** The pulse's box; the top `markRoom` px of it are kept for the mark's label. */
  chart: { x: number; y: number; w: number; h: number };
  markRoom: number;
  /** The times under the pulse. */
  axisY: number;
  /** The four numbers: the labels' line and size, the values' line and size. */
  labelY: number;
  labelSize: number;
  valueY: number;
  valueSize: number;
  /** A transfer under way: its box, when there is one. */
  transfer: { y: number; h: number } | null;
  /** The "press any key" line. */
  hintY: number;
}

/** The pulse's box height wanted, a share of the area; what is left above it is air. */
export const PULSE_SHARE = 0.3;

/**
 * The standby screen in a `W × H` area: `big` — the full form, else the short
 * one. The clock and the host take the top; the hint, a transfer and the four
 * numbers stand on the bottom; the pulse takes the height between them up to
 * `PULSE_SHARE` of the area — whatever is left goes above it, as air.
 */
export function pulseLayout(W: number, H: number, big: boolean, o: { yourTime: boolean; transfer: boolean }): PulseLayout {
  const pad = big ? 96 : 32;
  const clockSize = Math.round(Math.min(H * 0.15, W * 0.095, big ? 180 : 110));
  const clockY = big ? 76 : 24;
  const dateSize = big ? Math.max(14, Math.round(clockSize * 0.12)) : 12;
  const dateY = clockY + Math.round(clockSize * 1.05);
  const smallSize = big ? 12 : 10;
  const yourTimeY = dateY + dateSize + (big ? 8 : 5);
  const topBottom = o.yourTime ? yourTimeY + smallSize : dateY + dateSize;
  const hostSize = big ? 26 : 17;
  const hostY = clockY + (big ? 6 : 4);
  const verdictSize = big ? 20 : 14;
  const verdictY = hostY + Math.round(hostSize * 1.7);
  const hintY = H - 28;
  const transferH = big ? 78 : 44;
  const transfer = o.transfer ? { y: hintY - (big ? 24 : 14) - transferH, h: transferH } : null;
  const valueSize = big ? 46 : 28;
  const labelSize = big ? 12 : 10;
  const valueY = (transfer ? transfer.y : hintY) - (big ? 72 : 16) - valueSize;
  const labelY = valueY - labelSize - (big ? 8 : 4);
  const axisY = labelY - (big ? 40 : 22) - smallSize;
  const bottom = axisY - (big ? 10 : 6);
  const headSize = big ? 13 : 11;
  const headGap = big ? 22 : 12;
  const top = Math.max(topBottom + (big ? 40 : 18) + headSize + headGap, bottom - Math.round(H * PULSE_SHARE));
  return {
    pad,
    clockY,
    clockSize,
    dateY,
    dateSize,
    yourTimeY,
    smallSize,
    hostY,
    hostSize,
    verdictY,
    verdictSize,
    headY: top - headGap - headSize,
    headSize,
    chart: { x: pad, y: top, w: W - 2 * pad, h: bottom - top },
    markRoom: big ? 26 : 18,
    axisY,
    labelY,
    labelSize,
    valueY,
    valueSize,
    transfer,
    hintY,
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
// The pulse carries one mark at most (`pulseMark`): what happened at a moment
// is told by a short tooltip over what is under the pointer — a bucket (its
// time, its value, the busiest process) or a stretch vterm read nothing for. A
// pointer that rests stops showing it — a tooltip left up for hours would hold
// its pixels lit like any other.

/** How far past the pulse's sides, px, the pointer still picks what is at the end. */
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

/** A stretch of time, short: seconds under a minute, else as the uptime reads ("6m", "1h 2m", "2d 3h"). */
export function spanLabel(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  return s < 60 ? `${s}s` : fmtUptime(s);
}

// ── The verdict (v1.34, ADR 0065) ────────────────────────────────────────────

/** The verdict under the host: nothing read yet, all OK, or the worst problem and how many more there are. */
export type VerdictLine = { kind: "none" } | { kind: "ok" } | { kind: "problem"; problem: Problem; more: number };

/** The verdict for the newest reading (`read` — one came back) and the problems the status bar sees in it. */
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

/** The server clock's lead over this machine's in minutes, from its "HH:MM …" at local time `localAt`; null when it did not say. */
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
