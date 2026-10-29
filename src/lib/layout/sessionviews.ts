// What a connection shows (v1.11, ADR 0024): its terminal and the files open
// through it, in zones of its own area.
//
// A file belongs to its connection — it is read and saved through it, closes
// with it, moves to another window with it. So it is shown *inside* it: the
// connection's area is one zone holding the terminal and the files as views, or
// it is divided — the terminal beside a file, two files side by side — and each
// zone has its strip of views and shows one of them.
//
// The zones are the same tree of panes as the centre's (`splitlayout.ts`), one
// level down: a connection's layout is a `CenterLayout` whose "tabs" are its
// views. Nothing here re-implements the tree; this module only says what a
// connection's views are and where a new one goes. Pure — no DOM, no stores.

import {
  activateTab,
  activeTab,
  addTab,
  emptyLayout,
  focusedPane,
  loadLayout,
  neighbourPane,
  moveTab,
  paneOf,
  panes,
  removeTab,
  splitWithTab,
  type CenterLayout,
  type Edge,
  type Pane,
} from "./splitlayout";

/** The terminal among a connection's views. File ids are UUIDs: it cannot clash. */
export const TERMINAL_VIEW = "terminal";

/** A connection's zones: the centre's tree, with views for tabs. */
export type ViewLayout = CenterLayout;

/** A connection that shows nothing but its terminal. */
export const terminalOnly = (): ViewLayout => addTab(emptyLayout(), TERMINAL_VIEW);

/** Whether a view is a file (anything but the terminal). */
export const isFileView = (view: string | null): view is string =>
  view !== null && view !== TERMINAL_VIEW;

/**
 * The zone a newly opened file goes to. Once the connection is divided, files
 * have a place of their own — the zone in focus if it shows a file, else the
 * first zone that does — and a new one joins it, so that opening a file from
 * the file panel does not cover the terminal one is typing in. Undivided, the
 * only zone takes it: the file is shown in place of the terminal, as a tab
 * next to it.
 */
export function fileZone(layout: ViewLayout): Pane {
  const focus = focusedPane(layout);
  if (isFileView(focus.active)) return focus;
  return panes(layout).find((zone) => isFileView(zone.active)) ?? focus;
}

/** Open a file: it joins the file zone, is shown there, and that zone takes the focus. */
export function openView(layout: ViewLayout, file: string): ViewLayout {
  if (file === TERMINAL_VIEW) return layout;
  return addTab(layout, file, fileZone(layout).id);
}

/**
 * Close a file. Its zone shows the neighbour; a zone left with nothing goes,
 * and the other half of its split takes the room. The terminal is not a view
 * that closes — it goes with the connection.
 */
export function closeView(layout: ViewLayout, file: string): ViewLayout {
  return file === TERMINAL_VIEW ? layout : removeTab(layout, file);
}

/** Show a view in its zone and give that zone the focus. */
export const showView = (layout: ViewLayout, view: string): ViewLayout => activateTab(layout, view);

/**
 * Put a view into a zone of its own at `edge` of the zone it is in — the
 * terminal beside the file, a file beside another. A zone's only view cannot be
 * split off it: nothing would change.
 */
export function splitView(layout: ViewLayout, view: string, edge: Edge): ViewLayout {
  const zone = paneOf(layout, view);
  return zone ? splitWithTab(layout, view, zone.id, edge) : layout;
}

/** Move a view to the next zone (reading order, wrapping). */
export function moveViewNext(layout: ViewLayout, view: string): ViewLayout {
  const zone = paneOf(layout, view);
  return zone ? moveTab(layout, view, neighbourPane(layout, zone.id, 1).id) : layout;
}

/** The terminal is what its zone shows — it is on screen when the connection is. */
export const terminalShown = (layout: ViewLayout): boolean =>
  paneOf(layout, TERMINAL_VIEW)?.active === TERMINAL_VIEW;

/** The terminal is the view in focus: keys typed into the connection go to it. */
export const terminalFocused = (layout: ViewLayout): boolean => activeTab(layout) === TERMINAL_VIEW;

/** The file the zone in focus shows, if it shows one. */
export function focusedFile(layout: ViewLayout): string | null {
  const view = activeTab(layout);
  return isFileView(view) ? view : null;
}

/**
 * A layout that came from elsewhere — another window's packet — made sound for
 * the files that came with it: the terminal and every file in exactly one zone,
 * nothing else in any. What cannot be read is one zone showing the terminal.
 */
export function loadViews(raw: unknown, files: readonly string[]): ViewLayout {
  return loadLayout(raw, [TERMINAL_VIEW, ...files.filter((id) => id !== TERMINAL_VIEW)]);
}
