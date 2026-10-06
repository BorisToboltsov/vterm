// Presentation glue for the docks (v1.1): the tab label of each tool panel and
// the right-click menu that moves a panel to another dock — the keyboard-and-menu
// twin of dragging its tab. Kept out of `docklayout.ts` so the model stays free
// of i18n.

import type { IconName } from "./icons";
import type { MenuItem } from "./ctxmenu";
import { canHidePanel, DOCK_SIDES, type DockSide, type PanelId } from "./docklayout";
import { t, type MessageKey } from "./i18n";

/** The tab label of a tool panel. Reactive: reads the language through `t()`. */
export function panelLabel(id: PanelId): string {
  switch (id) {
    case "servers":
      return t("tree.servers");
    case "files":
      return "SFTP";
    case "git":
      return t("git.panelTitle");
    case "docker":
      return t("docker.panelTitle");
    case "k8s":
      return "k8s";
    case "ai":
      return t("ai.panelTitle");
  }
}

const MOVE_KEY: Record<DockSide, MessageKey> = {
  left: "dock.moveLeft",
  right: "dock.moveRight",
  bottom: "dock.moveBottom",
};

const MOVE_ICON: Record<DockSide, IconName> = {
  left: "chevronsLeft",
  right: "chevronsRight",
  bottom: "chevronDown",
};

/** "Move to the left/right/bottom panel" — the label of one move action. */
export const moveLabel = (side: DockSide): string => t(MOVE_KEY[side]);

/** The docks a panel sitting in `from` can be sent to. */
export const moveTargets = (from: DockSide): DockSide[] => DOCK_SIDES.filter((s) => s !== from);

/** The right-click menu of a dock tab: one "move to …" item per other dock. */
export function moveMenuItems(from: DockSide, onMove: (to: DockSide) => void): MenuItem[] {
  return moveTargets(from).map((to) => ({
    icon: MOVE_ICON[to],
    label: moveLabel(to),
    onSelect: () => onMove(to),
  }));
}

/**
 * The right-click menu of a dock tab: where it can go, then — for every panel
 * but the server tree — hiding it. Hidden panels come back from Settings →
 * Appearance → Panels and from the command palette.
 */
export function tabMenuItems(
  from: DockSide,
  panel: PanelId,
  on: { onMove: (to: DockSide) => void; onHide: () => void },
): MenuItem[] {
  const items = moveMenuItems(from, on.onMove);
  if (!canHidePanel(panel)) return items;
  return [
    ...items,
    { kind: "separator" },
    { icon: "eyeOff", label: t("dock.hide"), onSelect: on.onHide },
  ];
}
