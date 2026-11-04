// Picks the tier an empty state is drawn in (v1.30) — the tiers and why are in
// `../ui/emptytier.ts`.
//
// The element is the empty state's root: as tall as the room it is given and
// clipping what does not fit, so its height never depends on what it shows. The
// tier is its `data-tier`, which the markup reads through `group-data-[tier=…]`
// variants: trying a tier is setting the attribute and asking the layout whether
// the content overflows — synchronous, no render in between, so no frame is ever
// painted in a tier that does not fit.

import { pickTier } from "../ui/emptytier";

/**
 * `use:emptyFit={key}` — keeps `data-tier` on the roomiest tier that fits. The
 * key is what the state says (title, hint): a change re-fits it.
 */
export function emptyFit(node: HTMLElement, _key?: unknown) {
  const fit = (): void => {
    node.dataset.tier = pickTier((tier) => {
      node.dataset.tier = tier;
      return node.scrollHeight <= node.clientHeight;
    });
  };

  // A change inside (new text, a button that appears, the interface scale) is
  // fitted on the next frame rather than in the observer's callback: fitting
  // resizes the content, and a size changed during the callback of the element
  // that reported it is a resize loop the browser complains about.
  let frame = 0;
  const later = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fit();
    });
  };

  // The root's own size does not depend on the tier, so it is fitted at once —
  // no frame of a squeezed layout while a dock is being dragged.
  const observer = new ResizeObserver((entries) =>
    !entries?.length || entries.some((e) => e.target === node) ? fit() : later(),
  );
  observer.observe(node);
  for (const child of node.children) observer.observe(child);
  fit();

  return {
    update(): void {
      later();
    },
    destroy(): void {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
