// The interface scale (v1.28, ADR 0049): one number, in percent, for the whole
// program. It becomes the root font size, and the UI grows because everything in it
// is in rem — the type scale, Tailwind's spacing, `Icon`. Pure: the store applies it
// to the document, and a component that draws by a number of its own (a row height a
// virtual list counts with, a rail width) asks `uiPx` in the settings store.
//
// Only named stops: a free value would give the row heights and terminal cells a
// fraction nobody has looked at, and a stop is what a chord steps to.

export const UI_SCALE_STOPS = [90, 100, 110, 125, 150] as const;
export const DEFAULT_UI_SCALE = 100;

/** localStorage key read by the boot script in `app.html`, so that the first frame
 *  already has its size: the layout would otherwise jump once the store loads. */
export const UI_SCALE_KEY = "vterm.uiScale";

/** Px to the rem at 100 %. */
export const REM_PX = 16;

/** A stored value made safe to use: only a stop, anything else is the default. */
export function sanitizeUiScale(raw: unknown): number {
  return (UI_SCALE_STOPS as readonly unknown[]).includes(raw) ? (raw as number) : DEFAULT_UI_SCALE;
}

/** A size given at 100 %, at this scale. Not rounded: `h-7` at 110 % is 30.8 px, and
 *  a virtual list counts by what the rows really are. */
export const scaledPx = (px: number, scale: number): number => (px * scale) / 100;

/** The root font size of a scale, as CSS. */
export const rootFontSize = (scale: number): string => `${scale}%`;

/**
 * The terminal's font at this scale: the size in the settings is its base. Whole px:
 * a cell is measured from the font, and a fractional size only gives it a blurrier
 * edge, not a different width.
 */
export const terminalFontPx = (base: number, scale: number): number =>
  Math.round(scaledPx(base, scale));

/** Where a scale chord leads: one stop up (`1`), down (`-1`), or back to 100 % (`0`).
 *  Stays at the last stop instead of wrapping around. */
export function steppedUiScale(scale: number, step: 1 | -1 | 0): number {
  if (step === 0) return DEFAULT_UI_SCALE;
  const at = UI_SCALE_STOPS.indexOf(sanitizeUiScale(scale) as (typeof UI_SCALE_STOPS)[number]);
  return UI_SCALE_STOPS[Math.min(UI_SCALE_STOPS.length - 1, Math.max(0, at + step))];
}
