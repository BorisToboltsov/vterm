// Shared right-click (context) menu contract. The visual shell lives in
// [ContextMenu.svelte](./ContextMenu.svelte); surfaces (SFTP, server tree, tab
// bar, terminal, recordings, local files) describe their menu as a declarative
// list of `MenuItem`s and hand it to the primitive — no bespoke popup per panel.
// Pure logic (viewport clamping) stays here so it is testable without the DOM.
import type { IconName } from "./icons";

/** A clickable row. `kind` defaults to "action" when omitted. */
export interface MenuAction {
  kind?: "action";
  icon?: IconName;
  label: string;
  /** Red styling + used for destructive ops (delete, reset --hard). */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A thin divider between logical groups. */
export interface MenuSeparator {
  kind: "separator";
}

/** An inline, expandable group of sub-actions (e.g. git reset modes). */
export interface MenuSubmenu {
  kind: "submenu";
  /** Stable id used to track which submenu is expanded. */
  key: string;
  icon?: IconName;
  label: string;
  items: MenuAction[];
}

export type MenuItem = MenuAction | MenuSeparator | MenuSubmenu;

/** An open menu: viewport position + the rows to show. */
export interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * Keep a menu of size `w`×`h` fully inside the `vw`×`vh` viewport, preferring
 * its requested top-left (`x`, `y`) but shifting it left/up when it would spill
 * off the right/bottom edge, and never past the top-left `margin`.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin = 4,
): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, vw - w - margin)),
    y: Math.max(margin, Math.min(y, vh - h - margin)),
  };
}

/** Type guard: a real (clickable) action row, not a separator/submenu. */
export function isAction(item: MenuItem): item is MenuAction {
  return item.kind === undefined || item.kind === "action";
}
