// Tells a panel whether it is in its wide layout, by measuring it (v1.7). The
// threshold and the reason a panel would measure itself rather than use a
// container query are in `../layout/panelwide.ts`.

import { untrack } from "svelte";
import { REM_PX } from "../appearance/uiscale";
import { isWide } from "../layout/panelwide";
import { uiPx } from "../settings/settings.svelte";

/**
 * `use:wideWhen={(wide) => …}` — calls back with the panel's layout once at
 * mount and again whenever it crosses the threshold (never for a resize that
 * stays on one side of it).
 */
export function wideWhen(node: HTMLElement, onchange: (wide: boolean) => void) {
  let report = onchange;
  let last: boolean | null = null;
  const check = (): void => {
    // Container queries resolve `rem` against the root font size, which is this.
    const wide = isWide(node.clientWidth, uiPx(REM_PX));
    if (wide === last) return;
    last = wide;
    untrack(() => report(wide));
  };
  const observer = new ResizeObserver(check);
  observer.observe(node);
  check();
  // The interface scale moves the threshold and leaves the panel's size alone, so
  // the observer stays silent while the CSS has already switched its layout.
  $effect(check);
  return {
    update(next: (wide: boolean) => void) {
      report = next;
    },
    destroy() {
      observer.disconnect();
    },
  };
}
