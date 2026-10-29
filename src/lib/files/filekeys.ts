// Pure keyboard-navigation helpers for the file panels (SftpPanel/LocalFilePanel).
// The panels keep a `cursor` index into the visible entries; these functions turn
// a key press into the next cursor position and keep it scrolled into view. Kept
// DOM-free so the arithmetic is unit-tested without a virtual list.

/**
 * Next cursor index for a navigation key, or `null` if the key doesn't navigate.
 * `count` is the number of selectable rows; `pageRows` is a viewport's worth.
 * A cursor of `-1` (nothing focused yet) starts at the top/bottom on first move.
 */
export function nextCursor(
  key: string,
  cursor: number,
  count: number,
  pageRows: number,
): number | null {
  if (count === 0) return null;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  const first = cursor < 0;
  switch (key) {
    case "ArrowDown":
      return first ? 0 : clamp(cursor + 1);
    case "ArrowUp":
      return first ? count - 1 : clamp(cursor - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return first ? clamp(pageRows - 1) : clamp(cursor + pageRows);
    case "PageUp":
      return first ? 0 : clamp(cursor - pageRows);
    default:
      return null;
  }
}

/**
 * Scroll offset that keeps row `cursor` fully visible, given fixed row height,
 * the viewport height, the current scroll offset, and how many non-selectable
 * header rows (e.g. the ".." entry) sit above the selectable list. Returns the
 * current offset unchanged when the row is already in view.
 */
export function scrollForCursor(
  cursor: number,
  rowH: number,
  viewportH: number,
  scrollTop: number,
  headerRows: number,
): number {
  const top = (headerRows + cursor) * rowH;
  const bottom = top + rowH;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportH) return bottom - viewportH;
  return scrollTop;
}
