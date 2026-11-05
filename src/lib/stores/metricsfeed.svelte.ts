// The one source of a session's basic metrics (v1.34). The status bar, the
// monitoring page and the screensaver used to poll `fetch_metrics` each on its own
// timer — and the backend takes CPU% and every rate as the difference from the
// previous call for that session (`MetricsSamples`), so two pollers a moment apart
// read a load over a fraction of a second: the numbers jittered. Now one loop per
// session asks, and everyone who watches the session reads the same answer.
//
// A loop runs while someone watches (`watchMetrics`) and the window is visible.
// Each tick is one poll — numbered (`seq`) and appended to the session's history,
// a gap when it failed — so the bar's chart and the monitoring page's draw from
// the same samples, and the page opens with what the bar has seen since the tab
// connected. A watcher may bring a companion probe (the page's detail): it
// runs in the same tick, so its readings share the poll's number.
//
// The feed of a session outlives a tab switch — the bar shows the last reading at
// once instead of "loading" — and is dropped with the tab (`forgetMetrics` in
// `closeTabFully`).

import { fetchMetrics, type Metrics } from "../api";
import { pushReadings, readingsOf, type History } from "../monitoring/monhistory";
import { settings } from "../settings/settings.svelte";
import { isHidden } from "../ui/util";

export interface Feed {
  /** The newest reading that came back. */
  metrics: Metrics | null;
  /** When it came back (`Date.now()`), or null. */
  at: number | null;
  /** The number of the newest poll; −1 before the first. */
  seq: number;
  /** The basic readings by poll number (`readingsOf`), a gap where a poll failed. */
  hist: History;
  /** When the newest poll failed — null once one comes back. */
  failedAt: number | null;
}

/**
 * What a watcher brings to the loop. `companion` runs in the same tick as the basic
 * probe; `done` hears every tick: the reading (null — that poll failed), the
 * companion's answer (null — failed or none) and the poll's number. A watcher
 * that joins a running loop gets its first answer at once, fetched alone and
 * numbered −1: not a sample, so it is not drawn on the time axis.
 */
export interface Watcher<T = unknown> {
  companion?: () => Promise<T>;
  done?: (m: Metrics | null, extra: T | null, seq: number) => void;
}

const NONE: Feed = Object.freeze({ metrics: null, at: null, seq: -1, hist: {}, failedAt: null });

class FeedState {
  by = $state.raw<Record<string, Feed>>({});
}
/** Every session's feed, by session id. Replaced whole on change. */
export const metricsFeed = new FeedState();

/** The feed of `id` — an empty one before its first poll. */
export function feedOf(id: string): Feed {
  return metricsFeed.by[id] ?? NONE;
}

/**
 * The beat of the loops: the user's poll interval, but not under 2 s while a
 * watcher brings a companion — the page's detail probe is heavier than one a
 * second.
 */
export function pollEveryMs(heavy: boolean): number {
  return Math.max(heavy ? 2 : 1, Number(settings.statusPollInterval) || 0) * 1000;
}

interface Loop {
  watchers: Set<Watcher>;
  timer: ReturnType<typeof setTimeout> | undefined;
  busy: boolean;
  dead: boolean;
}
const loops = new Map<string, Loop>();

const heavy = (loop: Loop) => [...loop.watchers].some((w) => w.companion);

function put(id: string, feed: Feed) {
  metricsFeed.by = { ...metricsFeed.by, [id]: feed };
}

function schedule(id: string, loop: Loop, startedAt: number) {
  clearTimeout(loop.timer);
  loop.timer = undefined;
  if (loop.dead || loop.watchers.size === 0) return;
  const wait = Math.max(0, startedAt + pollEveryMs(heavy(loop)) - Date.now());
  loop.timer = setTimeout(() => void tick(id), wait);
}

async function tick(id: string): Promise<void> {
  const loop = loops.get(id);
  if (!loop || loop.dead || loop.busy) return;
  clearTimeout(loop.timer);
  loop.timer = undefined;
  const startedAt = Date.now();
  // A hidden window shows nothing: skip the round trip, keep the beat.
  if (isHidden()) return schedule(id, loop, startedAt);
  loop.busy = true;
  const ws = [...loop.watchers];
  const [mr, ...xr] = await Promise.allSettled([
    fetchMetrics(id),
    ...ws.map((w) => (w.companion ? w.companion() : Promise.resolve(null))),
  ]);
  loop.busy = false;
  if (loop.dead) return;
  const m = mr.status === "fulfilled" ? mr.value : null;
  const prev = feedOf(id);
  const seq = prev.seq + 1;
  // A failed poll keeps the last reading but not the moment: the history gets a
  // gap, so no chart draws a line through a time nobody read.
  put(
    id,
    m
      ? { metrics: m, at: Date.now(), seq, hist: pushReadings(prev.hist, seq, readingsOf(m, null)), failedAt: null }
      : { ...prev, seq, hist: pushReadings(prev.hist, seq, {}), failedAt: Date.now() },
  );
  ws.forEach((w, i) => {
    if (!loop.watchers.has(w)) return;
    const r = xr[i];
    w.done?.(m, r.status === "fulfilled" ? r.value : null, seq);
  });
  schedule(id, loop, startedAt);
}

/**
 * Watch `id`'s metrics until the returned function is called. The first watcher
 * starts the loop with a poll at once; a companion joining a running loop is
 * fetched at once on its own (numbered −1) and then rides the beat.
 */
export function watchMetrics<T>(id: string, w: Watcher<T> = {}): () => void {
  let loop = loops.get(id);
  if (!loop) {
    loop = { watchers: new Set(), timer: undefined, busy: false, dead: false };
    loops.set(id, loop);
  }
  const l = loop;
  const idle = l.watchers.size === 0;
  l.watchers.add(w as Watcher);
  if (idle && !l.busy) void tick(id);
  else if (w.companion) {
    w.companion().then(
      (x) => l.watchers.has(w as Watcher) && w.done?.(feedOf(id).metrics, x, -1),
      () => l.watchers.has(w as Watcher) && w.done?.(feedOf(id).metrics, null, -1),
    );
  }
  return () => {
    l.watchers.delete(w as Watcher);
    if (l.watchers.size === 0) {
      clearTimeout(l.timer);
      l.timer = undefined;
    }
  };
}

/**
 * A reading for a one-off question — the header of a recording, the host block
 * for the assistant: the newest if it is no older than one beat, else one asked
 * now. Not a sample: the history is left alone.
 */
export async function readMetrics(id: string): Promise<Metrics> {
  const f = feedOf(id);
  if (f.metrics && f.at != null && Date.now() - f.at < pollEveryMs(false)) return f.metrics;
  const m = await fetchMetrics(id);
  if (!loops.get(id)?.dead) put(id, { ...feedOf(id), metrics: m, at: Date.now(), failedAt: null });
  return m;
}

/** Drop `id`'s feed and stop its loop — the tab is gone (`closeTabFully`). */
export function forgetMetrics(id: string): void {
  const loop = loops.get(id);
  if (loop) {
    loop.dead = true;
    clearTimeout(loop.timer);
    loops.delete(id);
  }
  if (id in metricsFeed.by) {
    const rest = { ...metricsFeed.by };
    delete rest[id];
    metricsFeed.by = rest;
  }
}

// A window coming back into view polls at once rather than at the next beat.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (isHidden()) return;
    for (const [id, loop] of loops) if (loop.watchers.size > 0 && !loop.busy) void tick(id);
  });
}
