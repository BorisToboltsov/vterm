// The hint a plain click on a link in terminal output shows (v1.36): one line at
// the click — "Open in browser  ⌘-click" — with the opening behind its button,
// as PyCharm does. One per window, like the link question: a terminal's link
// gate (`terminal/linkgate.ts`) puts it up, `LinkHint.svelte` draws it and takes
// it down.
//
// It also knows whether the modifier is held: in modifier mode a link under the
// pointer shows the hand only while it is, since only then would a click open it.

import type { LinkHintKind, PagePoint } from "../terminal/linkgate";

/** The hint on screen: where the click landed, what it opens, and how. */
export interface LinkHint extends PagePoint {
  kind: LinkHintKind;
  act: () => void;
}

let hint = $state.raw<LinkHint | null>(null);
let held = $state(false);

/** The hint on screen now, or null. */
export const currentLinkHint = (): LinkHint | null => hint;

/** Put the hint up at the click: `act` is what its button does. */
export function showLinkHint(at: PagePoint, kind: LinkHintKind, act: () => void): void {
  hint = { x: at.x, y: at.y, kind, act };
}

/** Take the hint down without opening anything. */
export function dismissLinkHint(): void {
  hint = null;
}

/** The hint's button: the hint goes, and the link opens as ⌘-click opens it. */
export function followLinkHint(): void {
  const shown = hint;
  hint = null;
  shown?.act();
}

/** ⌘ (macOS) or Ctrl (elsewhere) is held down now. */
export const modifierHeld = (): boolean => held;

export function setModifierHeld(down: boolean): void {
  if (held !== down) held = down;
}
