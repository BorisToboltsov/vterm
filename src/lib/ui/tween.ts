// Smooth changes of a reading (v1.33): the screensaver and the monitoring page.
// A reading used to land in one frame: a ring jumped to its new share, its number
// to the new value, a chart's right edge to the new point — and a screen left up
// for hours twitched every few seconds. Now what is shown runs to each reading: a
// value eases from where it stands to where the reading puts it, a number counts
// on the way and lands on the reading. A reading that comes mid-way starts from
// where the value stands, never back from the old one. No DOM: IdleOverlay.svelte
// and the monitoring charts ask what to draw at a moment; durations go through
// `motionMs`, so with reduced motion every change is instant.

/** A ring and the number in it, the big numbers of the small cards. */
export const RING_MS = 700;
/** The right edge of a chart moving to the newest point. */
export const LINE_MS = 800;
/** A transfer's bar and percentage. */
export const BAR_MS = 300;
/**
 * Everything on the status bar (v1.34): a number, the edge of its small chart.
 * The bar is in view all day, at the edge of sight, where a long count draws
 * the eye every few seconds — so its changes are short, and nothing flashes.
 */
export const STATUS_MS = 300;
/** A chart's scale moving to a new ceiling. */
export const SCALE_MS = 600;
/** The history's line giving way to the one its merged points draw. */
export const MERGE_MS = 600;
/** The idle card's layout giving way to the one its new room takes (a dock opened, the window resized). */
export const TIER_MS = 400;

/** A value on its way from `from` to `to`, started at `at` (ms). `to` null — unknown, nothing to show. */
export interface Tween {
  from: number | null;
  to: number | null;
  at: number;
}

/** A value standing still. */
export const still = (v: number | null): Tween => ({ from: v, to: v, at: -Infinity });

/** How far along a change is, 0…1, `dur` ms after `at`: done at once without a duration. */
export function progress(at: number, now: number, dur: number): number {
  if (!(dur > 0) || !Number.isFinite(at)) return 1;
  return Math.min(1, Math.max(0, (now - at) / dur));
}

/** Fast at first, settling at the end: no stop with a jolt. */
export function easeOut(t: number): number {
  const k = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1;
  return 1 - (1 - k) ** 3;
}

/** What `tw` shows at `now`, for a change that takes `dur` ms. */
export function tweenAt(tw: Tween, now: number, dur: number): number | null {
  if (tw.to == null) return null;
  if (tw.from == null) return tw.to;
  return tw.from + (tw.to - tw.from) * easeOut(progress(tw.at, now, dur));
}

/**
 * `tw` sent on to `to` at `now`, from wherever it stands. A value that was not
 * known starts at `fromUnknown` — 0 for a ring, which fills; null for an axis,
 * which has nowhere to come from and stands at once. An unknown target stops
 * showing at once: a drop that was not read is not drawn.
 */
export function retarget(tw: Tween, to: number | null, now: number, dur: number, fromUnknown: number | null = 0): Tween {
  if (to == null || !Number.isFinite(to)) return still(null);
  if (to === tw.to) return tw;
  const from = tweenAt(tw, now, dur) ?? fromUnknown;
  if (from == null || !(dur > 0)) return still(to);
  return { from, to, at: now };
}
