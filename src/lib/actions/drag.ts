// Reusable pointer-drag helpers. Native HTML5 DnD is unreliable in WKWebView, so
// vterm uses pointer events everywhere (tab reorder, server/folder drag, panel
// resize). The pure helpers here are shared and unit-tested; `resizableHandle`
// is a Svelte action wrapping the capture/track/release dance for resize gutters.

/** Has the pointer moved at least `min` px from its start point? */
export function passedThreshold(
  startX: number,
  startY: number,
  x: number,
  y: number,
  min = 4,
): boolean {
  return Math.hypot(x - startX, y - startY) >= min;
}

/** The `[data-drop]` target under a point ("" = root container), or null. */
export function dropTargetAt(x: number, y: number): string | null {
  if (typeof document === "undefined") return null;
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
  return el ? (el.dataset.drop ?? "") : null;
}

/** A box in viewport coordinates. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where an element sits in the *layout*, in viewport coordinates — its box with
 * any transform ignored. `getBoundingClientRect` reports the transformed box, so
 * while a tab is sliding to a new slot (a FLIP animation is a transform) it
 * answers "where the tab is drawn", not "which slot it holds". Hit-testing a drag
 * against drawn boxes makes the target flicker: the neighbour that just gave way
 * is still under the pointer for the length of its animation, and gets swapped
 * straight back. Offsets are layout values and do not move with a transform.
 *
 * Falls back to `getBoundingClientRect` where the element has no offset parent
 * (not rendered — and jsdom, which lays nothing out).
 */
export function layoutBox(el: HTMLElement): Box {
  const parent = el.offsetParent;
  if (!(parent instanceof HTMLElement)) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  const pr = parent.getBoundingClientRect();
  return {
    left: pr.left + parent.clientLeft + el.offsetLeft - parent.scrollLeft,
    top: pr.top + parent.clientTop + el.offsetTop - parent.scrollTop,
    width: el.offsetWidth,
    height: el.offsetHeight,
  };
}

/**
 * Svelte `animate:` function for a tab strip: a sibling glides to its new slot
 * instead of jumping there. Translate only — `flip` from `svelte/animate` also
 * scales, and tabs that share a strip's width (`flex-1`) change size whenever one
 * is added, which squeezed their labels for the length of the animation.
 * `duration` comes from `motion()` (0 under reduced motion: the tab just moves).
 */
export function glide(
  _node: Element,
  { from, to }: { from: DOMRect; to: DOMRect },
  params: { duration?: number } = {},
): { duration: number; easing: (t: number) => number; css: (t: number, u: number) => string } {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  return {
    duration: dx === 0 && dy === 0 ? 0 : (params.duration ?? 0),
    easing: (t) => 1 - Math.pow(1 - t, 3),
    css: (_t, u) => `transform: translate(${u * dx}px, ${u * dy}px)`,
  };
}

/**
 * The index a dragged tab should take in its strip: one past every other tab
 * whose middle the pointer has gone beyond. `others` are the layout boxes of the
 * strip's other tabs, in order, along the strip's axis.
 *
 * The middle — not "whichever tab is under the pointer": after a swap with a
 * wider neighbour the pointer is still over that neighbour, and the edge rule
 * swaps it straight back on the next move. With the middle rule the tab has to
 * travel back across the neighbour's (new) middle, so the order holds still.
 */
export function slotIndex(pos: number, others: readonly { start: number; size: number }[]): number {
  let index = 0;
  for (const box of others) {
    if (pos > box.start + box.size / 2) index += 1;
  }
  return index;
}

export interface ResizableParams {
  /**
   * Called with the signed deltas (px) from the drag start: `dx` for a vertical
   * gutter between columns, `dy` for a horizontal one above the bottom dock.
   */
  onResize: (dx: number, dy: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

/**
 * Svelte action: turns a node into a drag-to-resize handle. Captures the pointer
 * on down, reports the delta on move, and releases on up/cancel.
 */
export function resizableHandle(node: HTMLElement, params: ResizableParams) {
  let p = params;
  let startX = 0;
  let startY = 0;
  let active = false;

  function down(e: PointerEvent) {
    active = true;
    startX = e.clientX;
    startY = e.clientY;
    node.setPointerCapture(e.pointerId);
    p.onStart?.();
  }
  function move(e: PointerEvent) {
    if (active) p.onResize(e.clientX - startX, e.clientY - startY);
  }
  function up(e: PointerEvent) {
    if (!active) return;
    active = false;
    try {
      node.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
    p.onEnd?.();
  }

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);

  return {
    update(next: ResizableParams) {
      p = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    },
  };
}
