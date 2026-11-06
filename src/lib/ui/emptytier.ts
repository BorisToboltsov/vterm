// How an empty state fits the room it has. The badge, the gaps and the padding
// shrink together by one number `k` (`./fluidfit.ts`): at 1 the badge is a 56 px
// circle with room around it; as the room goes the circle shrinks and two lines
// grow out of it to its sides, until at 0 it is a 36 px medallion set in a line of
// its own. Short of even that, the badge gives way — its icon moves into the
// title's row, the actions beside the title (`line`) — and then the hint (`title`).
// The title and the actions go last: they are what the state is for. A hint longer
// than two lines is cut to two once the badge starts to shrink.
//
// Before v1.30 the badge was a flex item of a centred column: short of room it was
// squeezed to the icon's height (a 56×28 oval) and the rest spilled out of the
// pane both ways. v1.30 drew four fixed tiers; between them the screen jumped.

import { fluidK, spanAt, type Span } from "./fluidfit";

/** The ways an empty state is laid out, roomiest first. */
export const EMPTY_TIERS = ["badge", "line", "title"] as const;

export type EmptyTier = (typeof EMPTY_TIERS)[number];

/** The badge's circle. */
export const BADGE: Span = { max: 56, min: 36 };
/** Its icon, as a share of its size at `k = 1` (26 px → 18 px). */
export const GLYPH: Span = { max: 1, min: 18 / 26 };
/** How far the lines beside the badge have grown out of it: none at `k = 1`. */
export const LINES: Span = { max: 0, min: 1 };
/** The gap between the badge and the text. */
export const GAP: Span = { max: 12, min: 8 };
/** The padding above and below. */
export const PAD_Y: Span = { max: 24, min: 8 };
/** The padding at the sides. */
export const PAD_X: Span = { max: 24, min: 16 };
/** The space above the actions under the text. */
export const CTA: Span = { max: 12, min: 8 };

/** What an empty state is drawn by: px at 100 %, the glyph and the lines factors. */
export interface EmptyLayout {
  badge: number;
  glyph: number;
  lines: number;
  gap: number;
  padY: number;
  padX: number;
  cta: number;
}

/** Without the badge: the icon in the title's row, the actions beside it. */
const TIGHT: Record<Exclude<EmptyTier, "badge">, Pick<EmptyLayout, "gap" | "padY" | "padX">> = {
  line: { gap: 4, padY: 6, padX: 12 },
  title: { gap: 4, padY: 2, padX: 12 },
};

/**
 * How big the badge can be: `k` in 0…1, or `null` when even the medallion does not
 * fit. `room` is the empty state's height, `text` the text's (title, hint, actions)
 * without the space above the actions, `actions` whether there are any.
 */
export function badgeFit(room: number, text: number, actions: boolean): number | null {
  return fluidK(room, text, [
    [PAD_Y, 2],
    [BADGE, 1],
    [GAP, 1],
    [CTA, actions ? 1 : 0],
  ]);
}

/** The sizes of a tier; `k` counts only for `badge`. */
export function layoutFor(tier: EmptyTier, k = 1): EmptyLayout {
  const kk = Math.min(1, Math.max(0, Number.isFinite(k) ? k : 1));
  if (tier === "badge") {
    return {
      badge: spanAt(BADGE, kk),
      glyph: spanAt(GLYPH, kk),
      lines: spanAt(LINES, kk),
      gap: spanAt(GAP, kk),
      padY: spanAt(PAD_Y, kk),
      padX: spanAt(PAD_X, kk),
      cta: spanAt(CTA, kk),
    };
  }
  return { badge: BADGE.min, glyph: GLYPH.min, lines: 1, cta: 0, ...TIGHT[tier] };
}
