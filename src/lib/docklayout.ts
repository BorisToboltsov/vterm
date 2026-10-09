// Dock layout model (v1.1): which tool panel lives in which dock, in what order,
// which one each dock shows, and how big and whether collapsed each dock is.
//
// Pure data + pure functions — no runes, no DOM, no i18n. The store
// (`stores/layout.svelte.ts`) holds one `Docks` value and persists it; the
// components only render it. Everything that decides *where a panel ends up*
// lives here so it is unit- and property-tested without a browser (ADR 0003).
//
// Two classes of tabs, never mixed (ADR 0015): the **tool panels** below move
// between the three docks; terminals and editors live in the centre and are not
// part of this model at all.

/** The three docks. `bottom` spans the whole window, above the status bar. */
export type DockSide = "left" | "right" | "bottom";
export const DOCK_SIDES: readonly DockSide[] = ["left", "right", "bottom"];

/** Every tool panel. `servers` is the saved-server tree; the rest need a session. */
export type PanelId = "servers" | "files" | "git" | "docker" | "k8s" | "ai";
export const PANEL_IDS: readonly PanelId[] = ["servers", "files", "git", "docker", "k8s", "ai"];

export const isPanelId = (v: unknown): v is PanelId =>
  typeof v === "string" && (PANEL_IDS as readonly string[]).includes(v);

export const isDockSide = (v: unknown): v is DockSide =>
  typeof v === "string" && (DOCK_SIDES as readonly string[]).includes(v);

/**
 * Whether a panel works on a session. The server tree is the only global panel:
 * it exists with no tab open, and it must not be torn down when the active
 * session changes — every other panel is rebuilt for the session in focus.
 */
export const isSessionPanel = (id: PanelId): boolean => id !== "servers";

export interface DockState {
  /** Tab order. Across the three docks every panel appears exactly once. */
  panels: PanelId[];
  /** The tab the dock shows; null only when the dock is empty. */
  active: PanelId | null;
  /** Width in px for left/right, height in px for bottom. */
  size: number;
  collapsed: boolean;
}

export type Docks = Record<DockSide, DockState>;

/** Schema version of the persisted layout (`vterm.layout`). */
export const LAYOUT_VERSION = 2;

export interface PersistedLayout {
  version: number;
  docks: Docks;
}

/** Size limits per dock, and the size a fresh install starts with. */
export const DOCK_BOUNDS: Record<DockSide, { min: number; max: number; initial: number }> = {
  left: { min: 160, max: 560, initial: 256 },
  right: { min: 240, max: 720, initial: 384 },
  bottom: { min: 120, max: 720, initial: 280 },
};

/** Thickness of a collapsed left/right dock (a `w-9` rail). */
export const COLLAPSED_RAIL = 36;

/**
 * How much of the window a dock may take, whatever size is stored: a layout
 * saved on a large monitor must not leave the terminal with no room on a laptop.
 */
export const BOTTOM_MAX_SHARE = 0.6;

const DEFAULT_PANELS: Record<DockSide, PanelId[]> = {
  left: ["servers"],
  right: ["files", "git", "ai"],
  bottom: ["docker", "k8s"],
};

const DEFAULT_COLLAPSED: Record<DockSide, boolean> = {
  left: false,
  right: true,
  bottom: true,
};

/** Clamp `v` into the inclusive `[lo, hi]` range. */
export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/** A dock size brought back inside that dock's limits. */
export const clampSize = (side: DockSide, px: number): number =>
  clamp(Math.round(px), DOCK_BOUNDS[side].min, DOCK_BOUNDS[side].max);

/**
 * The size a dock is actually drawn at: the stored size, but never more than
 * `BOTTOM_MAX_SHARE` of the window for the bottom dock. Left/right keep their
 * stored width (the centre column has its own `min-w-0` and simply narrows).
 */
export function effectiveSize(side: DockSide, size: number, viewport: number): number {
  if (side !== "bottom" || !(viewport > 0)) return size;
  return Math.max(DOCK_BOUNDS.bottom.min, Math.min(size, Math.floor(viewport * BOTTOM_MAX_SHARE)));
}

/** The layout of a fresh install. */
export function defaultDocks(): Docks {
  const docks = {} as Docks;
  for (const side of DOCK_SIDES) {
    const panels = [...DEFAULT_PANELS[side]];
    docks[side] = {
      panels,
      active: panels[0] ?? null,
      size: DOCK_BOUNDS[side].initial,
      collapsed: DEFAULT_COLLAPSED[side],
    };
  }
  return docks;
}

/** The dock a panel belongs to in a fresh install — where a missing panel is put back. */
function defaultSideOf(panel: PanelId): DockSide {
  return DOCK_SIDES.find((side) => DEFAULT_PANELS[side].includes(panel)) ?? "right";
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Rebuild a valid `Docks` from anything. The persisted layout is user-writable
 * (localStorage, restored backups, an older or newer build), so nothing in it is
 * trusted: unknown panels and duplicates are dropped, a panel that is missing —
 * for instance one added in a later version — goes back to its default dock, and
 * sizes are clamped. The result always holds every panel exactly once.
 */
export function sanitizeDocks(raw: unknown): Docks {
  const src = isRecord(raw) ? raw : {};
  const docks = {} as Docks;
  const seen = new Set<PanelId>();
  const wantedActive = {} as Record<DockSide, unknown>;

  for (const side of DOCK_SIDES) {
    const r = isRecord(src[side]) ? (src[side] as Record<string, unknown>) : {};
    const panels: PanelId[] = [];
    if (Array.isArray(r.panels)) {
      for (const id of r.panels) {
        if (isPanelId(id) && !seen.has(id)) {
          seen.add(id);
          panels.push(id);
        }
      }
    }
    wantedActive[side] = r.active;
    docks[side] = {
      panels,
      active: null,
      size:
        typeof r.size === "number" && Number.isFinite(r.size)
          ? clampSize(side, r.size)
          : DOCK_BOUNDS[side].initial,
      collapsed: typeof r.collapsed === "boolean" ? r.collapsed : DEFAULT_COLLAPSED[side],
    };
  }

  for (const id of PANEL_IDS) {
    if (!seen.has(id)) docks[defaultSideOf(id)].panels.push(id);
  }

  for (const side of DOCK_SIDES) {
    const d = docks[side];
    const want = wantedActive[side];
    d.active = isPanelId(want) && d.panels.includes(want) ? want : (d.panels[0] ?? null);
  }
  return docks;
}

/** Keys of the pre-1.1 layout (`leftWidth`/`sftpWidth`/…): one fixed dock per side. */
const LEGACY_KEYS = ["leftWidth", "leftCollapsed", "sftpWidth", "dockTab"];

/**
 * Carry a pre-1.1 layout over: the widths and the left collapse the user had,
 * and the tab the right dock showed. The panels themselves take the new default
 * arrangement — before 1.1 nobody could have arranged them.
 */
function migrateLegacy(raw: Record<string, unknown>): Docks {
  const docks = defaultDocks();
  if (typeof raw.leftWidth === "number" && Number.isFinite(raw.leftWidth)) {
    docks.left.size = clampSize("left", raw.leftWidth);
  }
  docks.left.collapsed = raw.leftCollapsed === true;
  if (typeof raw.sftpWidth === "number" && Number.isFinite(raw.sftpWidth)) {
    docks.right.size = clampSize("right", raw.sftpWidth);
  }
  if (isPanelId(raw.dockTab)) docks[dockOf(docks, raw.dockTab)].active = raw.dockTab;
  return docks;
}

/**
 * The layout to start with, from whatever `vterm.layout` holds: a current
 * layout is sanitized, a pre-1.1 one migrated, anything else is the default.
 * The only way a stored layout reaches the store (`docklayout.guard`).
 */
export function loadDocks(raw: unknown): Docks {
  if (!isRecord(raw)) return defaultDocks();
  if (isRecord(raw.docks)) return sanitizeDocks(raw.docks);
  if (LEGACY_KEYS.some((k) => k in raw)) return migrateLegacy(raw);
  return defaultDocks();
}

/** What gets written to `vterm.layout`. */
export function persistedLayout(docks: Docks): PersistedLayout {
  return { version: LAYOUT_VERSION, docks: cloneDocks(docks) };
}

function cloneDocks(docks: Docks): Docks {
  const out = {} as Docks;
  for (const side of DOCK_SIDES) {
    const d = docks[side];
    out[side] = { panels: [...d.panels], active: d.active, size: d.size, collapsed: d.collapsed };
  }
  return out;
}

/** The dock holding `panel`. Every panel is in exactly one, so this never misses. */
export function dockOf(docks: Docks, panel: PanelId): DockSide {
  return DOCK_SIDES.find((side) => docks[side].panels.includes(panel)) ?? defaultSideOf(panel);
}

/**
 * Move a panel to dock `to`, at `index` among that dock's tabs (omitted = last).
 * For a move inside one dock `index` is read against the list as the user sees
 * it — with the dragged tab still in place — so "drop on the gap after the third
 * tab" means the same thing whether or not the tab came from this dock.
 *
 * The target dock shows the panel and opens: a panel dropped into a collapsed
 * dock would otherwise vanish from the screen with nothing to say where it went.
 * The source dock falls back to the neighbour that took the panel's slot.
 * Returns the same object when nothing would change.
 */
export function movePanel(
  docks: Docks,
  panel: PanelId,
  to: DockSide,
  index?: number | null,
): Docks {
  const from = dockOf(docks, panel);
  const at = docks[from].panels.indexOf(panel);
  if (at < 0) return docks;

  const rest = docks[to].panels.filter((id) => id !== panel);
  let i = rest.length;
  if (index != null) {
    i = Math.trunc(index);
    // The caller counted the dragged tab itself; `rest` no longer has it.
    if (from === to && i > at) i -= 1;
    i = clamp(i, 0, rest.length);
  }

  if (from === to && i === at) return docks;

  const next = cloneDocks(docks);
  if (from !== to) {
    const src = next[from];
    src.panels.splice(at, 1);
    if (src.active === panel) src.active = src.panels[at] ?? src.panels[at - 1] ?? null;
  }
  const dst = next[to];
  dst.panels = [...rest.slice(0, i), panel, ...rest.slice(i)];
  dst.active = panel;
  dst.collapsed = false;
  return next;
}

/** Bring a panel on screen: its dock shows it and opens. */
export function revealPanel(docks: Docks, panel: PanelId): Docks {
  const side = dockOf(docks, panel);
  const d = docks[side];
  if (d.active === panel && !d.collapsed) return docks;
  const next = cloneDocks(docks);
  next[side].active = panel;
  next[side].collapsed = false;
  return next;
}

/**
 * Panels the user may hide in settings — every panel but the server tree: with
 * it gone there would be nothing on screen to connect from.
 */
export const HIDEABLE_PANELS: readonly PanelId[] = PANEL_IDS.filter((id) => id !== "servers");

export const canHidePanel = (id: PanelId): boolean => HIDEABLE_PANELS.includes(id);

/**
 * The hidden-panel list made safe to use (`settings.hiddenPanels` comes from
 * storage and from restored backups): known, hideable panels, each once.
 */
export function sanitizeHiddenPanels(raw: unknown): PanelId[] {
  if (!Array.isArray(raw)) return [];
  const out: PanelId[] = [];
  for (const id of raw) {
    if (isPanelId(id) && canHidePanel(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** `hidden` with `panel` added or removed. A panel that cannot be hidden is left out. */
export function withPanelHidden(
  hidden: readonly PanelId[],
  panel: PanelId,
  hide: boolean,
): PanelId[] {
  const rest = hidden.filter((id) => id !== panel);
  return hide && canHidePanel(panel) ? [...rest, panel] : rest;
}

/**
 * Which of `panels` can be shown right now: session panels need a session, and a
 * panel the user hid is not offered at all. A hidden panel keeps its place in
 * its dock's list — that is how it comes back where it was.
 */
export function offeredPanels(
  panels: readonly PanelId[],
  hasSession: boolean,
  hidden: readonly PanelId[] = [],
): PanelId[] {
  return panels.filter((id) => (hasSession || !isSessionPanel(id)) && !hidden.includes(id));
}

/** The panels of a dock that can be shown right now (see `offeredPanels`). */
export function availablePanels(
  dock: DockState,
  hasSession: boolean,
  hidden: readonly PanelId[] = [],
): PanelId[] {
  return offeredPanels(dock.panels, hasSession, hidden);
}

/**
 * The tab a dock displays: its stored `active` when that panel is available,
 * else the first available one. The stored value is left alone — closing the
 * last session (or hiding the panel) must not make the dock forget which panel
 * it was showing.
 */
export function shownPanel(
  dock: DockState,
  hasSession: boolean,
  hidden: readonly PanelId[] = [],
): PanelId | null {
  const tabs = availablePanels(dock, hasSession, hidden);
  return dock.active && tabs.includes(dock.active) ? dock.active : (tabs[0] ?? null);
}

/** Whether `panel` is the one its dock displays, with the dock open. */
export function isPanelShown(
  docks: Docks,
  panel: PanelId,
  hasSession: boolean,
  hidden: readonly PanelId[] = [],
): boolean {
  const d = docks[dockOf(docks, panel)];
  return !d.collapsed && shownPanel(d, hasSession, hidden) === panel;
}

/** Where a dragged panel would land. `index: null` = at the end of that dock. */
export interface DropTarget {
  side: DockSide;
  index: number | null;
}

/**
 * The insertion index for a pointer over tab `index`: before it while the
 * pointer is in the tab's first half along the strip, after it otherwise.
 * `pos`/`start`/`size` are measured along the strip's own axis, so the same rule
 * serves a horizontal strip and the vertical rail of a collapsed dock.
 */
export function insertionIndex(pos: number, start: number, size: number, index: number): number {
  return pos < start + size / 2 ? index : index + 1;
}

/**
 * Whether two drop targets are one target. A drag works its target out afresh
 * on every pointer move; a strip redrawn for the same target again starts its
 * slides over (see `glide` in actions/drag), so the same one is not rewritten.
 */
export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.side === b.side && a.index === b.index;
}

/** Whether dropping `panel` on `target` would change anything. */
export function dropChanges(docks: Docks, panel: PanelId, target: DropTarget): boolean {
  return movePanel(docks, panel, target.side, target.index) !== docks;
}

/**
 * The tab order each dock would have if the dragged panel were dropped on
 * `target` right now — what the strips draw while a tab is in the air, so the
 * other tabs can make room for it. Only the order: which tab a dock shows and
 * whether it is open do not change until the drop, or every panel under the
 * pointer's path would be shown and hidden again. No target = nothing moves.
 */
export function previewPanels(
  docks: Docks,
  panel: PanelId,
  target: DropTarget | null,
): Record<DockSide, PanelId[]> {
  const moved = target ? movePanel(docks, panel, target.side, target.index) : docks;
  return { left: moved.left.panels, right: moved.right.panels, bottom: moved.bottom.panels };
}
