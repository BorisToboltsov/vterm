// Fits an empty state to its room — the sizes and why are in `../ui/emptytier.ts`.
//
// The element is the empty state's root: as tall as the room it is given and
// clipping what does not fit, so its height never depends on what it shows. Its
// first child is the column: the badge's row (`data-empty-badge`) and the text's.
// The tier is the root's `data-tier`, which the markup reads through
// `group-data-[tier=…]` variants, the sizes are its `--empty-*` properties, and a
// hint cut to two lines is `data-clamp`. Fitting is synchronous: trying a layout is
// setting the attributes and asking the layout whether the content overflows — no
// frame is ever painted in a layout that does not fit.
//
// While the room changes a little at a time (a dock dragged) the badge follows it
// frame by frame: it shrinks, the lines grow out of it. When the room jumps, the
// blocks glide from where they were drawn (`./fluidglide.ts`); when the badge gives
// way, its icon flies into the title's row, and when there is room for it again, the
// circle grows out of that icon. Reduced motion places everything at once.

import { REM_PX } from "../appearance/uiscale";
import { uiPx } from "../settings/settings.svelte";
import { badgeFit, layoutFor, type EmptyLayout, type EmptyTier } from "../ui/emptytier";
import { createGlider, drawnRect, morph } from "./fluidglide";

/** The custom properties an empty state is drawn by, one per size of the model. */
export const EMPTY_VARS: Record<keyof EmptyLayout, string> = {
  badge: "--empty-badge",
  glyph: "--empty-glyph",
  lines: "--empty-lines",
  gap: "--empty-gap",
  padY: "--empty-pad-y",
  padX: "--empty-pad-x",
  cta: "--empty-cta",
};

/** A size of the model as CSS: px at 100 % in rem, so it follows the interface scale; factors as they are. */
export function cssValue(key: keyof EmptyLayout, value: number): string {
  return key === "glyph" || key === "lines" ? String(value) : `${value / REM_PX}rem`;
}

/** The root's `style` before the action has measured: the roomiest layout. */
export const EMPTY_STYLE = (Object.keys(EMPTY_VARS) as (keyof EmptyLayout)[])
  .map((key) => `${EMPTY_VARS[key]}: ${cssValue(key, layoutFor("badge", 1)[key])}`)
  .join("; ");

/**
 * `use:emptyFit={key}` — keeps the empty state in the roomiest layout that fits.
 * The key is what the state says (title, hint): a change re-fits it.
 */
export function emptyFit(node: HTMLElement, _key?: unknown) {
  const blocks = (): HTMLElement[] =>
    [...(node.firstElementChild?.children ?? [])] as HTMLElement[];
  const isBadge = (el: HTMLElement): boolean => el.hasAttribute("data-empty-badge");
  const part = (selector: string): HTMLElement | null => node.querySelector(selector);

  const lay = (tier: EmptyTier, k?: number, clamp = false): void => {
    node.dataset.tier = tier;
    if (clamp) node.dataset.clamp = "";
    else delete node.dataset.clamp;
    const sizes = layoutFor(tier, k);
    for (const key of Object.keys(EMPTY_VARS) as (keyof EmptyLayout)[]) {
      node.style.setProperty(EMPTY_VARS[key], cssValue(key, sizes[key]));
    }
  };
  const fits = (): boolean => node.scrollHeight <= node.clientHeight;

  const place = (): void => {
    lay("badge", 1);
    if (fits()) return;
    // Short of room the hint is cut to two lines first; then the badge shrinks.
    lay("badge", 1, true);
    const unit = uiPx(1);
    const actions = part("[data-empty-actions]") !== null;
    const text = blocks().reduce((sum, b) => (isBadge(b) ? sum : sum + b.offsetHeight), 0);
    const k = badgeFit(
      node.clientHeight / unit,
      text / unit - (actions ? layoutFor("badge", 1).cta : 0),
      actions,
    );
    if (k !== null) return lay("badge", k, true);
    lay("line");
    if (!fits()) lay("title");
  };

  const glider = createGlider();
  const fit = (glide: boolean): void => {
    const all = blocks();
    const from = glider.drawn(all);
    const hadBadge = node.dataset.tier === "badge";
    // Where the icon is drawn now: in the badge, or in the title's row.
    const icon = part(hadBadge ? "[data-empty-glyph]" : '[data-empty-icon="line"]');
    const iconAt = glide && icon ? drawnRect(icon, node) : undefined;
    place();
    const shifts = glider.settle(all, from, glide);
    const hasBadge = node.dataset.tier === "badge";
    if (!glide || hasBadge === hadBadge) return;
    // The badge gave way: its icon flies into the title's row, which its own row
    // carries. Room again: the circle grows out of the icon in the title's row.
    const row = all.findIndex((b) => !isBadge(b));
    const target = part(hasBadge ? '[data-empty-icon="badge"]' : '[data-empty-icon="line"]');
    if (target) morph(target, iconAt, hasBadge ? 0 : (shifts[row] ?? 0));
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
      fit(true);
    });
  };

  // The root's own size does not depend on the layout, so it is fitted at once —
  // no frame of a squeezed layout while a dock is being dragged.
  const observer = new ResizeObserver((entries) =>
    !entries?.length || entries.some((e) => e.target === node) ? fit(true) : later(),
  );
  observer.observe(node);
  for (const child of node.children) observer.observe(child);
  fit(false);

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
