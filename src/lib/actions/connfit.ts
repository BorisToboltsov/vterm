// Fits the connecting screen to its room — the sizes and why are in
// `../connect/connfit.ts`.
//
// The element is the screen's root: as tall as its pane, clipping what does not
// fit. Its first child is the column of blocks — the ring (`data-conn-ring`), the
// title, the checklist, the buttons. Fitting is synchronous, like `emptyFit`: the
// mode is `data-mode` on the root, the sizes are custom properties on it, and
// trying the ringless modes is setting the attribute and asking the layout whether
// the content overflows — no frame is painted in a layout that does not fit.
//
// While the room changes a little at a time (a dock or a split dragged, a dock
// opening) the screen follows it frame by frame. When it jumps (a split, a window
// maximised) the blocks glide from where they were drawn to their new place — by
// `transform` alone, so the glide lays nothing out; a block that comes back (the
// ring, once there is room for it) fades in by `opacity`. Where a block is drawn
// is its last place moved by the glide it is on, so a jump that comes mid-glide
// carries on from there; reduced motion places it at once (`./fluidglide.ts`).

import { REM_PX } from "../appearance/uiscale";
import { layoutFor, ringFit, type ConnLayout, type ConnMode } from "../connect/connfit";
import { uiPx } from "../settings/settings.svelte";
import { createGlider } from "./fluidglide";

/** The custom properties the screen is drawn by, one per size of the model. */
export const CONN_VARS: Record<keyof ConnLayout, string> = {
  ring: "--conn-ring",
  gap: "--conn-gap",
  padY: "--conn-pad-y",
  padX: "--conn-pad-x",
  glyph: "--conn-glyph",
};

/** A size of the model as CSS: px at 100 % in rem, so it follows the interface scale; the glyph a factor. */
export function cssValue(key: keyof ConnLayout, value: number): string {
  return key === "glyph" ? String(value) : `${value / REM_PX}rem`;
}

/**
 * `use:connFit={key}` — keeps the screen in the roomiest layout that fits. The
 * key is what the screen says (title, detail, steps): a change re-fits it.
 */
export function connFit(node: HTMLElement, _key?: unknown) {
  const blocks = (): HTMLElement[] =>
    [...(node.firstElementChild?.children ?? [])] as HTMLElement[];
  const isRing = (el: HTMLElement): boolean => el.hasAttribute("data-conn-ring");

  const lay = (mode: ConnMode, k?: number): void => {
    node.dataset.mode = mode;
    const sizes = layoutFor(mode, k);
    for (const key of Object.keys(CONN_VARS) as (keyof ConnLayout)[]) {
      node.style.setProperty(CONN_VARS[key], cssValue(key, sizes[key]));
    }
  };

  const place = (): void => {
    // The blocks' heights as the full screen lays them out, in px at 100 %.
    lay("ring");
    const unit = uiPx(1);
    const all = blocks();
    const text = all.reduce((sum, b) => (isRing(b) ? sum : sum + b.offsetHeight), 0);
    const k = ringFit(node.clientHeight / unit, text / unit, all.length - 1);
    if (k !== null) return lay("ring", k);
    lay("line");
    if (node.scrollHeight > node.clientHeight) lay("title");
  };

  const glider = createGlider();
  const fit = (glide: boolean): void => {
    const all = blocks();
    const from = glider.drawn(all);
    place();
    glider.settle(all, from, glide, isRing);
  };

  // A change inside (new text, the interface scale) is fitted on the next frame:
  // fitting resizes the content, and a size changed during the callback of the
  // element that reported it is a resize loop the browser complains about.
  let frame = 0;
  const later = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fit(true);
    });
  };

  // The root's own size does not depend on the layout, so it is fitted at once —
  // no frame of a squeezed screen while a dock is being dragged.
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
