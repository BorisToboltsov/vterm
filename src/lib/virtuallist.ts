// Fixed-height list virtualization (Phase 18.7). A directory with tens of
// thousands of entries would hang the UI if every row were rendered, because
// Svelte's `{#each}` creates a DOM node per item. `windowRange` computes which
// slice of a uniform-height list is visible for the current scroll position, so
// the panel renders only that window (plus a small overscan) and pads the rest
// with spacer height. Pure + unit-tested; the panels wire it to a scroll handler.

/** The visible slice of a virtualized list plus the spacing around it. */
export interface ListWindow {
  /** First item index to render (inclusive). */
  start: number;
  /** One past the last item index to render (exclusive). */
  end: number;
  /** Pixels of empty space before `start` (top spacer / translate offset). */
  padTop: number;
  /** Total scroll height of the full list, so the scrollbar is sized correctly. */
  totalHeight: number;
}

/**
 * Compute the render window for a fixed-row-height list.
 *
 * @param scrollTop  current scroll offset of the container (px)
 * @param viewportH  visible height of the container (px)
 * @param rowH       height of one row (px); must be > 0
 * @param count      total number of items
 * @param overscan   extra rows to render above/below the viewport (default 6)
 */
export function windowRange(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  count: number,
  overscan = 6,
): ListWindow {
  const totalHeight = Math.max(0, count) * rowH;
  if (count <= 0 || rowH <= 0 || viewportH <= 0) {
    return { start: 0, end: Math.max(0, count), padTop: 0, totalHeight };
  }
  // Clamp scrollTop into range so an overscroll bounce can't push the window out.
  const top = Math.min(Math.max(scrollTop, 0), totalHeight);
  const first = Math.floor(top / rowH);
  const visibleRows = Math.ceil(viewportH / rowH);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visibleRows + overscan);
  return { start, end, padTop: start * rowH, totalHeight };
}
