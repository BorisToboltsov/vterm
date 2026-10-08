// Tells a panel whether it is in its wide layout, by measuring it (v1.7). The
// threshold and the reason a panel would measure itself rather than use a
// container query are in `../panelwide.ts`.

import { isWide } from "../panelwide";

/** Px to the rem: container queries resolve `rem` against the root font size. */
function rootRem(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return px > 0 ? px : 16;
}

/**
 * `use:wideWhen={(wide) => …}` — calls back with the panel's layout once at
 * mount and again whenever it crosses the threshold (never for a resize that
 * stays on one side of it).
 */
export function wideWhen(node: HTMLElement, onchange: (wide: boolean) => void) {
  let report = onchange;
  let last: boolean | null = null;
  const check = (): void => {
    const wide = isWide(node.clientWidth, rootRem());
    if (wide === last) return;
    last = wide;
    report(wide);
  };
  const observer = new ResizeObserver(check);
  observer.observe(node);
  check();
  return {
    update(next: (wide: boolean) => void) {
      report = next;
    },
    destroy() {
      observer.disconnect();
    },
  };
}
