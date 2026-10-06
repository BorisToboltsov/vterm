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

export interface OnScreenInput {
  /** The tab each pane shows (`shownTabs`). */
  shown: readonly string[];
  /** The session in focus, or null. */
  active: string | null;
  /** Broadcast mode replaces the panes with its own view. */
  broadcast: boolean;
  /** Broadcast layout: a grid of every member, or one focused member. */
  grid: boolean;
  /** Open tabs in the broadcast group. */
  members: readonly string[];
}

/**
 * The sessions whose terminals are on screen right now. With panes that is one
 * tab per pane; broadcast mode shows its own set — every member in the grid, the
 * focused one otherwise.
 *
 * "On screen" is what "watched" means for a recording (an unwatched tab's
 * recording is paused) and for a server's login question (it waits until the
 * tab is shown).
 */
export function onScreenSessions(i: OnScreenInput): string[] {
  if (!i.broadcast) return [...i.shown];
  if (i.grid) return [...i.members];
  return i.active === null ? [] : [i.active];
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
