// Pure logic of the standby card (v1.31): the screensaver layouts that fill a
// large terminal area — the server's clock, four rings, the history of the whole
// time away with what happened in it, a transfer under way. No DOM and no store:
// IdleOverlay.svelte paints, this decides, idle-standby tests pin it down.

import type { Threshold } from "../settings/settings.svelte";
import { thresholdLevel, type ThresholdLevel } from "../monitoring/thresholds";
import { loadHealth } from "../monitoring/monhealth";
import { etaSeconds, transferPct, type TransferRow } from "../files/transfer";
import { loadFraction, type IdleSample } from "./idlefx";

// ── History of the time away ─────────────────────────────────────────────────
// Every sample of the time away is kept, but the chart has a fixed number of
// points: past `AWAY_POINTS`, neighbours merge pairwise. A merged point is the
// PEAK of the two — an average would flatten the very spike the events below
// name, and the chart would contradict its own label. A sample vterm could not
// take is a gap (`null`), never a guessed value: the line breaks there.

/** One point of the chart: each series a fraction 0…1 (null — unknown), at a wall-clock time. */
export interface AwayPoint extends IdleSample {
  /** Wall-clock milliseconds (`Date.now()`) of the sample, or of the first one merged into it. */
  at: number;
}

/** Which metric an event is about: the three lines of the chart. */
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

export interface AwayHistory {
  points: AwayPoint[];
  events: AwayEvent[];
}

/** One poll, as the overlay hands it over; `null` fields were not reported. */
export interface AwayReading {
  at: number;
  cpuPct: number | null;
  memPct: number | null;
  load1: number | null;
  cpuCount: number | null;
  topProc: string;
}

/** The thresholds an event is measured against (the status bar's own). */
export interface AwayThresholds {
  cpu?: Threshold;
  ram?: Threshold;
  load?: Threshold;
}

/** How many points the chart keeps before neighbours merge. */
export const AWAY_POINTS = 240;
/** How many events are kept: the oldest go first — the newest are the ones to see. */
export const AWAY_EVENTS = 50;

export const emptyAway = (): AwayHistory => ({ points: [], events: [] });

const peakOf = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.max(a, b);

/** Halve `points` by merging neighbours into their peak. An odd last point stays as it is. */
export function mergePoints(points: readonly AwayPoint[]): AwayPoint[] {
  const out: AwayPoint[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const a = points[i];
    const b = points[i + 1];
    if (!b) {
      out.push(a);
      continue;
    }
    out.push({ at: a.at, cpu: peakOf(a.cpu, b.cpu), mem: peakOf(a.mem, b.mem), load: peakOf(a.load, b.load) });
  }
  return out;
}

/** A reading the overlay could not take: every series unknown at `at`. */
export const gapReading = (at: number): AwayReading => ({
  at,
  cpuPct: null,
  memPct: null,
  load1: null,
  cpuCount: null,
  topProc: "",
});

const fraction = (pct: number | null) => (pct == null || !Number.isFinite(pct) ? null : Math.min(1, Math.max(0, pct / 100)));

/** The level a reading puts each metric at, or null for a metric it did not report. */
export function readingLevels(r: AwayReading, th: AwayThresholds): Record<AwayKey, ThresholdLevel | null> {
  const perCore = r.load1 != null && r.cpuCount != null && r.cpuCount > 0 ? r.load1 / r.cpuCount : null;
  return {
    cpu: r.cpuPct == null ? null : thresholdLevel(r.cpuPct, th.cpu),
    mem: r.memPct == null ? null : thresholdLevel(r.memPct, th.ram),
    load: r.load1 == null ? null : loadHealth(r.load1, perCore, th.load),
  };
}

const RANK: Record<ThresholdLevel, number> = { ok: 0, warn: 1, crit: 2 };
const worse = (a: AwayEvent["level"], b: AwayEvent["level"]) => (RANK[b] > RANK[a] ? b : a);

/**
 * The history after one more reading. The point joins the chart (merging past
 * `cap`); each metric above its threshold opens an event or extends its open one,
 * and a metric back at ok — or not reported — closes it: a stretch vterm did not
 * see is not claimed to have gone on.
 */
export function awayPush(h: AwayHistory, r: AwayReading, th: AwayThresholds, cap = AWAY_POINTS): AwayHistory {
  let points = [
    ...h.points,
    { at: r.at, cpu: fraction(r.cpuPct), mem: fraction(r.memPct), load: loadFraction(r.load1, r.cpuCount) },
  ];
  while (points.length > Math.max(2, cap)) points = mergePoints(points);
  const levels = readingLevels(r, th);
  const value: Record<AwayKey, number | null> = { cpu: r.cpuPct, mem: r.memPct, load: r.load1 };
  const events = h.events.map((e) => ({ ...e }));
  for (const key of ["cpu", "mem", "load"] as const) {
    const level = levels[key];
    const v = value[key];
    let open: AwayEvent | undefined;
    for (let i = events.length - 1; i >= 0 && !open; i--) if (events[i].key === key && events[i].open) open = events[i];
    if (level == null || level === "ok" || v == null) {
      if (open) open.open = false;
      continue;
    }
    const top = key === "mem" ? "" : r.topProc.trim();
    const cores = key === "load" ? r.cpuCount : null;
    if (open) {
      open.end = r.at;
      open.level = worse(open.level, level);
      if (v > open.peak) Object.assign(open, { peak: v, peakAt: r.at, top, cores });
    } else {
      events.push({ key, level, start: r.at, end: r.at, peak: v, peakAt: r.at, top, cores, open: true });
    }
  }
  return { points, events: events.slice(-AWAY_EVENTS) };
}

/**
 * Canvas points of one series across a `w × h` box at (`x0`, `y0`), placed by
 * TIME over `from…to` (merged points are not evenly spaced), fraction 1 at the
 * top edge. Split into runs at unknown points, so a gap is drawn as a gap.
 */
export function timeRuns(
  points: readonly AwayPoint[],
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
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (const pt of points) {
    const v = pt[key];
    if (v == null) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push({ x: xAt(pt.at), y: y0 + h - Math.min(1, Math.max(0, v)) * h });
  }
  if (run.length) runs.push(run);
  return runs;
}

/** The x of wall-clock time `at` on a `from…to` axis of width `w` starting at `x0`. */
export function timeX(at: number, from: number, to: number, x0: number, w: number): number {
  return to > from ? x0 + ((at - from) / (to - from)) * w : x0;
}

/**
 * The events worth a label, most telling first: red before amber, then the
 * higher peak against its own scale. At most `max`.
 */
export function notableEvents(events: readonly AwayEvent[], max: number): AwayEvent[] {
  const scale = (e: AwayEvent) => (e.key === "load" ? (e.cores ? e.peak / e.cores : 0) : e.peak / 100);
  return [...events]
    .sort((a, b) => RANK[b.level] - RANK[a.level] || scale(b) - scale(a) || a.start - b.start)
    .slice(0, Math.max(0, max));
}

/**
 * Which of the labels — each `[left, right]` in px, in the order given — can
 * stand on one line without touching an earlier one (`gap` px apart). Returns
 * the indexes kept: the first label always stands.
 */
export function placeLabels(spans: readonly [number, number][], gap = 8): number[] {
  const kept: number[] = [];
  spans.forEach(([l, r], i) => {
    if (kept.every((k) => r + gap <= spans[k][0] || l >= spans[k][1] + gap)) kept.push(i);
  });
  return kept;
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
