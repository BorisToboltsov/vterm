// Presentation glue for the top bar's buttons (v1.16): what each one is called,
// which icon stands for it, and the bar's right-click menu — the keyboard-and-
// menu twin of pinning from the Utilities panel and of dragging a button. Kept
// out of `topbaractions.ts` so the model stays free of i18n.

import type { IconName } from "../ui/icons";
import type { MenuAction, MenuItem } from "../ui/ctxmenu";
import { t } from "../i18n";
import { UTILITIES } from "../utilities/utilities";
import {
  actionUtility,
  BUILTIN_ACTIONS,
  canUnpin,
  utilAction,
  type BuiltinAction,
  type TopbarId,
} from "./topbaractions";

const BUILTIN_ICON: Record<BuiltinAction, IconName> = {
  broadcast: "broadcast",
  notes: "note",
  monitoring: "barChart",
  // The bar draws REC as a dot and three letters; a list needs a glyph.
  record: "play",
  recordings: "activity",
  utilities: "wrench",
  settings: "settings",
};

function builtinLabel(id: BuiltinAction): string {
  switch (id) {
    case "broadcast":
      return t("broadcast.title");
    case "notes":
      return t("topbar.notes");
    case "monitoring":
      return t("topbar.monitoring");
    case "record":
      return t("topbar.record");
    case "recordings":
      return t("recordings.title");
    case "utilities":
      return t("util.title");
    case "settings":
      return t("topbar.settings");
  }
}

const utility = (id: TopbarId) => {
  const name = actionUtility(id);
  return name === null ? undefined : UTILITIES.find((u) => u.id === name);
};

/** What a button is called in a list. Reactive: reads the language through `t()`. */
export function actionLabel(id: TopbarId): string {
  const util = utility(id);
  if (util) return t(util.titleKey);
  return actionUtility(id) === null ? builtinLabel(id as BuiltinAction) : id;
}

/** The glyph that stands for a button in a list and at the pointer while it is dragged. */
export function actionIcon(id: TopbarId): IconName {
  return utility(id)?.icon ?? BUILTIN_ICON[id as BuiltinAction] ?? "wrench";
}

/** One row of the menu's checklist: ticked while the button is on the bar. */
function checkRow(
  id: TopbarId,
  list: readonly TopbarId[],
  on: { pin: (id: TopbarId) => void; unpin: (id: TopbarId) => void },
): MenuAction {
  const onBar = list.includes(id);
  return {
    checked: onBar,
    label: actionLabel(id),
    // An anchor is on the bar and stays there: shown ticked, not offered.
    disabled: onBar && !canUnpin(id),
    onSelect: () => (onBar ? on.unpin(id) : on.pin(id)),
  };
}

/**
 * The bar's right-click menu. Over a button — first what can be done with that
 * one (take it off; or keep it, for an indicator shown only while its state is
 * on); then every button there is as a checklist, the tools in a group of their
 * own; last, the way back to the bar a fresh install has.
 */
export function topbarMenu(
  list: readonly TopbarId[],
  target: TopbarId | null,
  on: { pin: (id: TopbarId) => void; unpin: (id: TopbarId) => void; reset: () => void },
): MenuItem[] {
  const items: MenuItem[] = [];
  if (target !== null) {
    if (!list.includes(target)) {
      items.push({ icon: "pin", label: t("topbar.pin"), onSelect: () => on.pin(target) });
    } else if (canUnpin(target)) {
      items.push({ icon: "close", label: t("topbar.unpin"), onSelect: () => on.unpin(target) });
    }
    if (items.length > 0) items.push({ kind: "separator" });
  }
  for (const id of BUILTIN_ACTIONS) items.push(checkRow(id, list, on));
  items.push({
    kind: "submenu",
    key: "tools",
    icon: "wrench",
    // Not "Utilities": that is the row above, the button that opens the panel.
    label: t("topbar.tools"),
    items: UTILITIES.map((u) => checkRow(utilAction(u.id), list, on)),
  });
  items.push({ kind: "separator" }, { icon: "refresh", label: t("topbar.reset"), onSelect: on.reset });
  return items;
}
