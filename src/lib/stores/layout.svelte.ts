// Dock layout store (Svelte 5 runes): the one `Docks` value the three docks
// render — which tool panel sits where, the tab each dock shows, its size and
// collapse — persisted to localStorage under `vterm.layout`.
//
// The model and every decision about it are pure (`../docklayout.ts`); this file
// only holds the value, applies the pure functions to it and writes it back.
// A stored layout reaches the store through `loadDocks` and nothing else: it
// sanitizes a current layout and migrates the pre-1.1 keys (`docklayout.guard`).

import {
  clampSize,
  defaultDocks,
  loadDocks,
  movePanel as movePanelIn,
  persistedLayout,
  revealPanel as revealPanelIn,
  withPanelHidden,
  type Docks,
  type DockSide,
  type PanelId,
} from "../docklayout";
import { settings } from "../settings.svelte";
import { resetColumnWidths } from "./colwidths.svelte";

export const STORAGE_KEY = "vterm.layout";

function load(): Docks {
  try {
    return loadDocks(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return defaultDocks();
  }
}

export const layout = $state<{ docks: Docks }>({ docks: load() });

/** Back to the layout of a fresh install ("Reset layout", and tests). */
export function resetLayout(): void {
  layout.docks = defaultDocks();
}

/**
 * "Reset panel layout": the docks and the column widths of their lists —
 * everything the user laid out by hand. Which panels are hidden is a setting
 * and stays as it is.
 */
export function resetPanelLayout(): void {
  resetLayout();
  resetColumnWidths();
}

/** Move a tool panel to another dock (or reorder it); `index` omitted = last. */
export function movePanel(panel: PanelId, to: DockSide, index?: number | null): void {
  const next = movePanelIn(layout.docks, panel, to, index);
  if (next !== layout.docks) layout.docks = next;
}

/**
 * Bring a panel on screen: its dock shows it and opens. A panel the user hid in
 * settings stays hidden — an indicator or a shortcut must not undo that choice.
 */
export function revealPanel(panel: PanelId): void {
  if (isPanelHidden(panel)) return;
  const next = revealPanelIn(layout.docks, panel);
  if (next !== layout.docks) layout.docks = next;
}

/** Whether the user hid this panel (`settings.hiddenPanels`; reactive). */
export function isPanelHidden(panel: PanelId): boolean {
  return settings.hiddenPanels.includes(panel);
}

/**
 * Hide a tool panel, or bring it back. The setting lives in `settings` (so a
 * backup carries it), the panel's place in its dock stays in the layout — which
 * is why a panel that returns stands where it stood. The server tree cannot be
 * hidden; asking is a no-op.
 */
export function setPanelHidden(panel: PanelId, hidden: boolean): void {
  const next = withPanelHidden(settings.hiddenPanels, panel, hidden);
  if (next.length !== settings.hiddenPanels.length) settings.hiddenPanels = next;
}

/** Show `panel` in its dock without opening a collapsed dock. */
export function activatePanel(side: DockSide, panel: PanelId): void {
  const d = layout.docks[side];
  if (d.panels.includes(panel)) d.active = panel;
}

export function setDockCollapsed(side: DockSide, collapsed: boolean): void {
  layout.docks[side].collapsed = collapsed;
}

export function toggleDock(side: DockSide): void {
  layout.docks[side].collapsed = !layout.docks[side].collapsed;
}

/** Resize a dock; the size is clamped to that dock's limits. */
export function setDockSize(side: DockSide, px: number): void {
  layout.docks[side].size = clampSize(side, px);
}

$effect.root(() => {
  $effect(() => {
    const data = JSON.stringify(persistedLayout(layout.docks));
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch {
      /* storage unavailable — non-fatal */
    }
  });
});
