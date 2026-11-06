// How the connecting screen fits the room it has (ConnectingOverlay). The ring,
// the gaps between the blocks and the padding around them shrink together, by one
// number `k`: 1 is the screen as it is drawn when there is room, 0 the smallest
// ring that still reads as one. Short of even that, the ring gives way: the
// spinner moves into the title's row (`line`), then the checklist folds into it
// and the title's row names the step under way (`title`). The title and the
// buttons go last — they are what the screen is for.
//
// Before this the ring was a flex item of a centred column as tall as the pane.
// Short of room the browser took the height from it — the only block that could
// give any — and a 64 px ring became a 64×35 oval; shorter still, the screen
// spilled out of its pane both ways. The action (`actions/connfit.ts`) measures,
// this module decides; sizes are px at 100 % (the action converts). How one number
// fits a screen, and how its jumps glide, is `../ui/fluidfit.ts`.

import { fluidK, spanAt, type Span } from "../ui/fluidfit";

/** The ways the screen is laid out, roomiest first. */
export const CONN_MODES = ["ring", "line", "title"] as const;

export type ConnMode = (typeof CONN_MODES)[number];

/** The ring's diameter. */
export const RING: Span = { max: 64, min: 32 };
/** The gap between the blocks (ring, title, checklist, buttons). */
export const GAP: Span = { max: 20, min: 12 };
/** The padding above and below. */
export const PAD_Y: Span = { max: 24, min: 12 };
/** The padding at the sides. */
export const PAD_X: Span = { max: 24, min: 16 };
/** The server glyph in the ring (and the failure badge with it), as a share of its size at `k = 1`. */
export const GLYPH: Span = { max: 1, min: 14 / 22 };
/** Without the ring: the spinner sits in the title's row. */
export const TIGHT = { gap: 10, padY: 8, padX: 12 } as const;

/** What the screen is drawn by: px at 100 %, the glyph a factor. */
export interface ConnLayout {
  ring: number;
  gap: number;
  padY: number;
  padX: number;
  glyph: number;
}

/**
 * How big the ring can be: `k` in 0…1, or `null` when even the smallest ring does
 * not fit. `room` is the screen's height, `text` the height of every block but the
 * ring, `gaps` how many gaps there are between the blocks. The height needed is
 * linear in `k`, so `k` is solved rather than searched for.
 */
export function ringFit(room: number, text: number, gaps: number): number | null {
  return fluidK(room, text, [
    [PAD_Y, 2],
    [RING, 1],
    [GAP, gaps],
  ]);
}

/** The sizes of a mode; `k` counts only for `ring`. */
export function layoutFor(mode: ConnMode, k = 1): ConnLayout {
  const kk = Math.min(1, Math.max(0, Number.isFinite(k) ? k : 1));
  if (mode === "ring") {
    return {
      ring: spanAt(RING, kk),
      gap: spanAt(GAP, kk),
      padY: spanAt(PAD_Y, kk),
      padX: spanAt(PAD_X, kk),
      glyph: spanAt(GLYPH, kk),
    };
  }
  return { ring: RING.min, ...TIGHT, glyph: GLYPH.min };
}
