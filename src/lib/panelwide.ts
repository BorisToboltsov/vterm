// The width at which a tool panel takes its wide layout (v1.1, ADR 0015) — for
// the decisions CSS cannot make.
//
// A panel adapts to the room it has, never to the dock it sits in. Where that is
// a matter of laying the same markup out differently, it is CSS: `@container` on
// the panel and `@wide:` variants (`--container-wide` in app.css). Two things CSS
// cannot do, and they read the same threshold from here:
//
//  - choose behaviour — whether "details" open beside the list or as a dialog;
//  - lay out a panel whose sub-components own dialogs. `@container` makes its
//    element the containing block of `position: fixed` descendants in some
//    engines, so it must not stand above a dialog; such a panel measures itself
//    (`actions/panelwide.ts`) instead.
//
// One number, two readers: `panelwide.test.ts` holds this constant and the CSS
// variable together.

/** `--container-wide` in app.css, in rem. */
export const WIDE_REM = 48;

/** Whether a panel `widthPx` wide is in its wide layout, with `remPx` px to the rem. */
export function isWide(widthPx: number, remPx = 16): boolean {
  if (!Number.isFinite(widthPx) || !(remPx > 0)) return false;
  return widthPx >= WIDE_REM * remPx;
}
