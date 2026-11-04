// How an empty state fits the room it has (v1.30). The same message is drawn in
// one of four tiers, roomiest first; the empty state measures itself
// (`actions/emptyfit.ts`) and takes the first tier whose layout fits its own
// height. What gives way, in order: the big badge (it becomes a medallion set in
// a line of its own), then the badge altogether (an icon in the title's row),
// then the hint. The title and the actions go last — they are what the state is
// for.
//
// Before this the badge was a flex item of a centred column: short of room it was
// squeezed to the icon's height (a 56×28 oval) and the rest spilled out of the
// pane both ways, over the dock's tab strip above. A tier never squeezes, and
// what still does not fit stays inside the empty state.

/** The tiers, roomiest first: the order they are tried in. */
export const EMPTY_TIERS = ["full", "medal", "line", "title"] as const;

export type EmptyTier = (typeof EMPTY_TIERS)[number];

/**
 * The roomiest tier whose layout `fits`; the tightest when none does — it is the
 * least that still says what the state is about.
 */
export function pickTier(fits: (tier: EmptyTier) => boolean): EmptyTier {
  for (const tier of EMPTY_TIERS) if (fits(tier)) return tier;
  return EMPTY_TIERS[EMPTY_TIERS.length - 1];
}
