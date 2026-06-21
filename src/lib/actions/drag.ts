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

export interface ResizableParams {
  /** Called with the signed horizontal delta (px) from the drag start. */
  onResize: (dx: number) => void;
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
  let active = false;

  function down(e: PointerEvent) {
    active = true;
    startX = e.clientX;
    node.setPointerCapture(e.pointerId);
    p.onStart?.();
  }
  function move(e: PointerEvent) {
    if (active) p.onResize(e.clientX - startX);
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
