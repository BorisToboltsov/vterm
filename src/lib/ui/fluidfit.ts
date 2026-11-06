// A screen that fits the room it has by one number (the connecting screen, the
// empty state). Its sizes run between what it draws with room to spare (`k = 1`)
// and the least it still reads at (`k = 0`); the height it needs is linear in `k`,
// so `k` is solved for, not searched. Short of `k = 0` the screen gives up a part
// (a ring, a badge) — that is a layout of its own, and the step to it glides.
//
// The glide: a jump in the room (a split, a dock opened) re-lays the screen out at
// once, and each block starts where it was drawn and moves to its new place by
// `transform` alone; a block that comes back fades in; a part that moves between
// two places (an icon from a badge into the title's row) flies from one to the
// other. The DOM side is `actions/fluidglide.ts`; this is what it computes.

/** A size at `k = 1` (`max`) and at `k = 0` (`min`). */
export interface Span {
  readonly max: number;
  readonly min: number;
}

/** A span at `k`. */
export const spanAt = (span: Span, k: number): number => span.min + (span.max - span.min) * k;

/** A part of the height that follows `k`: its span, counted `times` (two paddings, three gaps). */
export type Part = readonly [span: Span, times: number];

/**
 * The `k` at which the parts and `fixed` — what does not follow `k` — need `room`:
 * at most 1, `null` when even `k = 0` needs more than there is.
 */
export function fluidK(room: number, fixed: number, parts: readonly Part[]): number | null {
  let least = fixed;
  let per = 0;
  for (const [span, times] of parts) {
    least += times * span.min;
    per += times * (span.max - span.min);
  }
  if (!(room >= least)) return null;
  return per > 0 ? Math.min(1, (room - least) / per) : 1;
}

/** Where a block stands: the middle of its box from the screen's top, and its height. */
export interface Box {
  mid: number;
  height: number;
}

/**
 * Where a block is drawn: laid out at `laid`, moved by the glide it is on — its
 * computed `transform` (`none`, `matrix(…)` or `matrix3d(…)`; a glide only moves
 * and scales, so the vertical shift and scale are all that is read).
 */
export function drawnBox(laid: Box, transform: string): Box {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (!m) return laid;
  const v = m[2].split(",").map(Number);
  const [scale, shift] = m[1] ? [v[5], v[13]] : [v[3], v[5]];
  if (!Number.isFinite(scale) || !Number.isFinite(shift)) return laid;
  return { mid: laid.mid + shift, height: laid.height * scale };
}

/**
 * The glide that takes a block from where it is drawn to where it is now laid out:
 * a shift, and for a block that scales (a ring) a scale; `null` when there is
 * nothing to show — it was not drawn, is not drawn now, or moves by less than a pixel.
 */
export function glideFrom(
  drawn: Box | undefined,
  laid: Box,
  scales: boolean,
): { dy: number; scale: number } | null {
  if (!drawn || !(drawn.height > 0) || !(laid.height > 0)) return null;
  const dy = drawn.mid - laid.mid;
  const scale = scales ? drawn.height / laid.height : 1;
  if (Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01) return null;
  return { dy, scale };
}

/**
 * Whether a block comes back: it was there and hidden (a ring once there is room
 * for it again, a checklist unfolding), and is drawn now — it fades in rather than
 * pop up while the others glide. A block the fit has not seen yet does not.
 */
export function comesBack(drawn: Box | undefined, laid: Box): boolean {
  return drawn !== undefined && !(drawn.height > 0) && laid.height > 0;
}

/** A box on the screen: its left and top edges from the screen's, and its size. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How a part laid out at `to` starts where it was drawn at `from` (as another
 * element, in another place): centre on centre, as wide as it was. `carried` is the
 * vertical shift its block's own glide starts at — the block carries it, so the part
 * adds only the rest. `null` when there is nothing to show.
 */
export function morphFrom(
  from: Rect | undefined,
  to: Rect,
  carried = 0,
): { dx: number; dy: number; scale: number } | null {
  if (!from || !(from.width > 0) || !(to.width > 0)) return null;
  const dx = from.x + from.width / 2 - (to.x + to.width / 2);
  const dy = from.y + from.height / 2 - (to.y + to.height / 2) - carried;
  const scale = from.width / to.width;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01) return null;
  return { dx, dy, scale };
}

/** What one item of a row does when the row changes which items it shows. */
export type RowMove =
  /** Shown before and after, in another place: it glides there. */
  | { kind: "glide"; key: string; dx: number; dy: number }
  /** Shown before, not now: drawn once more where it was, it goes into «⋯» (`to`) or fades there. */
  | { kind: "leave"; key: string; from: Rect; to: Rect | null }
  /** Not shown before, shown now: it comes out of «⋯» (`from`) or fades in. */
  | { kind: "enter"; key: string; from: Rect | null; to: Rect };

/**
 * How a row's items move from where they were drawn (`before`) to where they are
 * laid out now (`after`), by key. `more` is the key of the row's «⋯»: what leaves
 * goes into it and what comes back comes out of it — «⋯» itself, appearing or
 * going, only fades.
 */
export function rowMoves(
  before: ReadonlyMap<string, Rect>,
  after: ReadonlyMap<string, Rect>,
  more: string | null = null,
): RowMove[] {
  const moreAfter = more === null ? undefined : after.get(more);
  const moreBefore = more === null ? undefined : before.get(more);
  const out: RowMove[] = [];
  for (const [key, from] of before) {
    const to = after.get(key);
    if (to) {
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) out.push({ kind: "glide", key, dx, dy });
    } else {
      out.push({ kind: "leave", key, from, to: key === more ? null : (moreAfter ?? moreBefore ?? null) });
    }
  }
  for (const [key, to] of after) {
    if (!before.has(key)) out.push({ kind: "enter", key, from: key === more ? null : (moreBefore ?? null), to });
  }
  return out;
}
