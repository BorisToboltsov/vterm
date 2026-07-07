// Pure helpers for pinch-to-zoom of the terminal font (Terminal.svelte).
//
// A trackpad pinch — and a Ctrl+wheel on a mouse — is delivered by the browser
// as a `wheel` event with `ctrlKey === true`; `deltaY < 0` means "zoom in"
// (fingers spreading), `deltaY > 0` means "zoom out". The raw deltas are small
// and arrive in a stream, so we accumulate them and step the (integer) font size
// by one each time the accumulator crosses a threshold, carrying the remainder.
// Keeping this logic here (not in the .svelte) lets it be unit-tested without a DOM.

// Matches the font-size bounds of the appearance settings input (8–32).
export const TERM_FONT_MIN = 8;
export const TERM_FONT_MAX = 32;

// Wheel-delta units to accumulate per 1px change. Tuned for macOS trackpad pinch,
// where each gesture tick reports a small fractional deltaY. Higher = less
// sensitive (a wider pinch is needed to change the font by one step).
export const PINCH_STEP = 42;

export interface PinchResult {
  /** New font size, clamped to [TERM_FONT_MIN, TERM_FONT_MAX]. */
  size: number;
  /** Leftover accumulated delta to carry into the next event. */
  accum: number;
}

/**
 * Fold one wheel `deltaY` into the running pinch accumulator and return the
 * resulting font size. `deltaY < 0` grows the font, `deltaY > 0` shrinks it.
 * At a clamp boundary the accumulator is drained so it can't grow unbounded.
 */
export function accumulatePinch(size: number, accum: number, deltaY: number): PinchResult {
  accum += deltaY;
  let next = size;
  // deltaY negative (zoom in) drives accum negative → step the font up.
  while (accum <= -PINCH_STEP && next < TERM_FONT_MAX) {
    next += 1;
    accum += PINCH_STEP;
  }
  while (accum >= PINCH_STEP && next > TERM_FONT_MIN) {
    next -= 1;
    accum -= PINCH_STEP;
  }
  // Don't let the accumulator pile up while pushing against a limit.
  if (next === TERM_FONT_MAX && accum < 0) accum = 0;
  if (next === TERM_FONT_MIN && accum > 0) accum = 0;
  return { size: next, accum };
}
