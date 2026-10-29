// What the centre shows (v1.2): the small decisions between the pane tree
// (`splitlayout.ts`) and the page that draws it. Pure — no DOM, no stores.

import type { Rect } from "./splitlayout";

/**
 * The CSS box of a pane rectangle inside the centre area. Positions are
 * percentages of the area the rectangles were computed for, so the browser keeps
 * the panes in proportion through a window resize without waiting for a new
 * measurement; `inset` (px) is taken off the top — the pane's own tab strip.
 */
export function rectStyle(
  rect: Rect | undefined,
  bounds: { width: number; height: number },
  inset = 0,
): string {
  if (!rect || !(bounds.width > 0) || !(bounds.height > 0)) {
    return `left: 0; top: ${inset}px; width: 100%; height: calc(100% - ${inset}px)`;
  }
  const pct = (v: number, of: number): string => `${+((v / of) * 100).toFixed(4)}%`;
  return (
    `left: ${pct(rect.x, bounds.width)}; top: calc(${pct(rect.y, bounds.height)} + ${inset}px); ` +
    `width: ${pct(rect.w, bounds.width)}; height: calc(${pct(rect.h, bounds.height)} - ${inset}px)`
  );
}

/**
 * The CSS box of the strip along the top of a rectangle, `height` px tall — the
 * strip of views a zone of a connection carries (v1.11). Same percentages as
 * {@link rectStyle}, so the strip and the body under it move together.
 */
export function stripStyle(
  rect: Rect | undefined,
  bounds: { width: number; height: number },
  height: number,
): string {
  if (!rect || !(bounds.width > 0) || !(bounds.height > 0)) {
    return `left: 0; top: 0; width: 100%; height: ${height}px`;
  }
  const pct = (v: number, of: number): string => `${+((v / of) * 100).toFixed(4)}%`;
  return (
    `left: ${pct(rect.x, bounds.width)}; top: ${pct(rect.y, bounds.height)}; ` +
    `width: ${pct(rect.w, bounds.width)}; height: ${height}px`
  );
}

/**
 * Offset of a dragged view's label from the pointer, the gap it keeps from the
 * area's edge, and the room it is given until it has been measured — the
 * widest a label gets.
 */
const VIEW_GHOST = { dx: 12, dy: 8, width: 200, height: 28, margin: 4 };

/**
 * Where to draw the label of a view dragged inside its connection (v1.11.1):
 * it hangs from the pointer, and stops at the edge of the connection's area. A
 * file cannot be taken out of the connection it is read and saved through — a
 * label that followed the pointer out would say it could.
 *
 * `size` is the label as drawn. It stops flush with the edge only when its own
 * size is known: a short name given the room of the longest would stop well
 * short of the edge, as if something else were in the way. Until the label is
 * measured (zero or absent) it gets the room of the widest.
 */
export function confinedGhost(
  x: number,
  y: number,
  area: Rect | null,
  size?: { w: number; h: number },
): { x: number; y: number } {
  const at = { x: x + VIEW_GHOST.dx, y: y + VIEW_GHOST.dy };
  if (!area) return at;
  const w = size && size.w > 0 ? size.w : VIEW_GHOST.width;
  const h = size && size.h > 0 ? size.h : VIEW_GHOST.height;
  // An area smaller than the label keeps it at its near edge.
  const within = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  return {
    x: within(at.x, area.x + VIEW_GHOST.margin, area.x + area.w - w - VIEW_GHOST.margin),
    y: within(at.y, area.y + VIEW_GHOST.margin, area.y + area.h - h - VIEW_GHOST.margin),
  };
}

/**
 * The sessions whose terminals are on screen right now: of the tabs the panes
 * show, those whose connection shows its terminal — one that shows only a file
 * (v1.11: a file is a view inside its connection) has no terminal on screen.
 *
 * "On screen" is what "watched" means for a recording (an unwatched tab's
 * recording is paused) and for a server's login question (it waits until the
 * tab is shown). The synchronous-input group has no say here since v1.9: its
 * members are on screen when their panes show them, like any other tab.
 */
export function onScreenSessions(
  shown: readonly string[],
  showsTerminal: (tab: string) => boolean,
): string[] {
  return shown.filter(showsTerminal);
}

/**
 * The on-screen session whose login question the dialog shows: the one in focus
 * when it has a question, otherwise the first that does. One dialog at a time —
 * the others wait their turn.
 */
export function pendingAuthSession(
  onScreen: readonly string[],
  active: string | null,
  asked: (sessionId: string) => boolean,
): string | null {
  if (active !== null && onScreen.includes(active) && asked(active)) return active;
  return onScreen.find(asked) ?? null;
}

/**
 * Which recordings to pause and which to keep running: a recording runs only
 * while its tab is on screen.
 */
export function recordingPauses(
  recording: readonly string[],
  onScreen: readonly string[],
): { pause: string[]; watch: string[] } {
  const seen = new Set(onScreen);
  return {
    pause: recording.filter((id) => !seen.has(id)),
    watch: recording.filter((id) => seen.has(id)),
  };
}
