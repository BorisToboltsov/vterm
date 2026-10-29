// The buttons of the top bar as data (v1.16): which actions there are, which of
// them the user keeps on the bar and in what order, what the bar shows for a
// given state, and what fits. Pure — no DOM, no i18n (the labels are in
// `topbarui.ts`), no store: `settings.topbar` holds the list, and it is changed
// only through the functions here (`stores/topbarpins.svelte.ts`).
//
// The bar used to be seven fixed buttons. Now it is a list the user edits: a
// button can be taken off, a tool of the Utilities panel can be put on, and the
// order is the user's. Three things the list cannot do — each is a way the bar
// would start lying or lock the user out:
//
//  - take Settings or Utilities off. With Settings gone, a bar emptied by
//    mistake has no button left to undo that from. And the Utilities window is
//    where every action taken off the bar is still listed, explained and run
//    from (`sessionactions.ts`): two of them — broadcast and server notes —
//    have no other button anywhere, so without the wrench they would be gone;
//  - hide a recording or a broadcast that is running: REC and the broadcast
//    button are how one sees that keystrokes are being recorded, or are going
//    to twelve servers. Unpinned, they come back for as long as that is true;
//  - push the breadcrumb out: what does not fit goes into the «⋯» menu, by the
//    pixels there are, not by a count.

import { isUtility, UTILITIES } from "../utilities/utilities";

/** The actions the bar has always had, in the order it has always shown them. */
export const BUILTIN_ACTIONS = [
  "broadcast",
  "notes",
  "monitoring",
  "record",
  "recordings",
  "utilities",
  "settings",
] as const;

export type BuiltinAction = (typeof BUILTIN_ACTIONS)[number];
/** A button of the bar: a built-in action, or one tool of the Utilities panel. */
export type TopbarId = BuiltinAction | `util:${string}`;

/** The bar as it was before it could be edited — what a fresh install shows. */
export const DEFAULT_TOPBAR: readonly TopbarId[] = BUILTIN_ACTIONS;

const UTIL = "util:";

/** The bar button that opens the utility `id`. */
export const utilAction = (id: string): TopbarId => `${UTIL}${id}`;

/** The utility a bar button opens, or null for a built-in action. */
export const actionUtility = (id: TopbarId): string | null =>
  id.startsWith(UTIL) ? id.slice(UTIL.length) : null;

const isBuiltin = (v: string): v is BuiltinAction =>
  (BUILTIN_ACTIONS as readonly string[]).includes(v);

/** Whether `v` names a button this build has (a tool removed later is not one). */
export function isTopbarId(v: unknown): v is TopbarId {
  if (typeof v !== "string") return false;
  return isBuiltin(v) || (v.startsWith(UTIL) && isUtility(v.slice(UTIL.length)));
}

/** Every button there is: the built-in ones, then the tools in the panel's order. */
export function allTopbarIds(): TopbarId[] {
  return [...BUILTIN_ACTIONS, ...UTILITIES.map((u) => utilAction(u.id))];
}

/**
 * The two buttons the bar is never without, in the order they close it:
 * Utilities — where what was taken off is still found — and Settings.
 */
export const ANCHORS = ["utilities", "settings"] as const satisfies readonly BuiltinAction[];

const isAnchor = (id: TopbarId): boolean => (ANCHORS as readonly string[]).includes(id);

/** Whether a button can be taken off the bar: any but the two anchors. */
export const canUnpin = (id: TopbarId): boolean => !isAnchor(id);

/**
 * The built-in actions that are about the session in focus, in the order the
 * Utilities window lists them. Each can be taken off the bar and stays there.
 */
export const SESSION_ACTIONS = [
  "monitoring",
  "record",
  "recordings",
  "broadcast",
  "notes",
] as const satisfies readonly BuiltinAction[];

export type SessionAction = (typeof SESSION_ACTIONS)[number];

/**
 * The stored list (`settings.topbar`) made safe to use: known buttons only,
 * each once, the two anchors among them. Storage is user-writable and outlives
 * the build that wrote it. What is not a list at all is the default bar; an
 * empty list is the user's own — a bar with nothing but the anchors.
 */
export function sanitizeTopbar(raw: unknown): TopbarId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TOPBAR];
  const out: TopbarId[] = [];
  for (const id of raw) if (isTopbarId(id) && !out.includes(id)) out.push(id);
  for (const id of ANCHORS) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * `list` with `id` on the bar. A new button stands just before Settings when
 * Settings closes the bar (the gear stays the last thing on it), else at the end.
 */
export function withPinned(list: readonly TopbarId[], id: TopbarId): TopbarId[] {
  if (list.includes(id) || !isTopbarId(id)) return [...list];
  const at = list[list.length - 1] === "settings" ? list.length - 1 : list.length;
  return [...list.slice(0, at), id, ...list.slice(at)];
}

/** `list` with `id` off the bar. An anchor does not go. */
export function withUnpinned(list: readonly TopbarId[], id: TopbarId): TopbarId[] {
  return canUnpin(id) ? list.filter((x) => x !== id) : [...list];
}

/**
 * `list` with `id` moved to stand before the button that is at `index` now
 * (`list.length` — to the end). An `id` that is not on the bar moves nothing.
 */
export function moveTopbar(list: readonly TopbarId[], id: TopbarId, index: number): TopbarId[] {
  const from = list.indexOf(id);
  if (from < 0 || !Number.isFinite(index)) return [...list];
  const to = Math.max(0, Math.min(list.length, Math.trunc(index)));
  const rest = list.filter((x) => x !== id);
  rest.splice(to > from ? to - 1 : to, 0, id);
  return rest;
}

/** Whether dropping `id` at `index` would change the order. */
export function moveChanges(list: readonly TopbarId[], id: TopbarId, index: number): boolean {
  return moveTopbar(list, id, index).some((x, i) => x !== list[i]);
}

/** The order the bar draws while `id` is held over `over` — the list itself with no target. */
export function previewTopbar(
  list: readonly TopbarId[],
  id: TopbarId | null,
  over: number | null,
): TopbarId[] {
  return id === null || over === null ? [...list] : moveTopbar(list, id, over);
}

/** What the bar needs to know of the session to decide what it shows. */
export interface TopbarState {
  /** A recording is running on the tab in focus. */
  recording: boolean;
  /** The tab in focus is a member of the broadcast group. */
  broadcastActive: boolean;
  /** A server is selected in the tree — the notes button has something to open. */
  showNotes: boolean;
}

/** One button the bar shows. */
export interface ShownAction {
  id: TopbarId;
  /** On the user's list. False for a state indicator that is shown regardless. */
  pinned: boolean;
}

/**
 * Whether the bar shows `id` whatever the list says and however little room
 * there is: the anchors, a recording that is running, a broadcast that is on.
 */
export function mustShow(id: TopbarId, state: TopbarState): boolean {
  if (isAnchor(id)) return true;
  if (id === "record") return state.recording;
  if (id === "broadcast") return state.broadcastActive;
  return false;
}

/**
 * The buttons the bar shows, left to right: the user's list, without the notes
 * button while no server is selected, and — ahead of it — the indicators of a
 * recording or a broadcast the user took off the bar and that is running now.
 */
export function shownTopbar(list: readonly TopbarId[], state: TopbarState): ShownAction[] {
  const indicators = (["broadcast", "record"] as const).filter(
    (id) => !list.includes(id) && mustShow(id, state),
  );
  return [
    ...indicators.map((id): ShownAction => ({ id, pinned: false })),
    ...list
      .filter((id) => id !== "notes" || state.showNotes)
      .map((id): ShownAction => ({ id, pinned: true })),
  ];
}

/**
 * Sizes of the bar, px — what the classes in `TopBar.svelte` come to: an icon
 * button (`p-1.5` around a 15 px icon), the REC button, the gap between
 * buttons, the room the breadcrumb keeps, and the bar's own padding and the
 * gap between the breadcrumb and the buttons.
 */
export const TOPBAR_SIZES = { icon: 27, record: 56, gap: 4, crumb: 160, chrome: 32 } as const;

const widthOf = (id: TopbarId): number =>
  id === "record" ? TOPBAR_SIZES.record : TOPBAR_SIZES.icon;

/** The room the buttons have in a bar `barWidth` px wide; 0 when it is not measured. */
export function topbarRoom(barWidth: number): number {
  if (!(barWidth > 0)) return 0;
  return Math.max(0, barWidth - TOPBAR_SIZES.crumb - TOPBAR_SIZES.chrome);
}

/**
 * Which of `ids` the bar draws in `room` px and which go into the «⋯» menu.
 * Everything, when it fits or the room is not known yet. Otherwise the menu's
 * own button takes room first, then the buttons that must be seen (`kept`),
 * then the rest in their order for as long as they fit — and from the first
 * one that does not, all that follow go to the menu: a bar that skipped a wide
 * button to squeeze in a narrow one after it would not read as a prefix of the
 * user's order.
 */
export function fitTopbar(
  ids: readonly TopbarId[],
  room: number,
  kept: (id: TopbarId) => boolean = () => false,
): { shown: TopbarId[]; overflow: TopbarId[] } {
  const gap = TOPBAR_SIZES.gap;
  const total = ids.reduce((sum, id) => sum + widthOf(id) + gap, -gap);
  if (!(room > 0) || total <= room) return { shown: [...ids], overflow: [] };
  const show = new Set(ids.filter(kept));
  let left = room - TOPBAR_SIZES.icon;
  for (const id of show) left -= widthOf(id) + gap;
  for (const id of ids) {
    if (show.has(id)) continue;
    const need = widthOf(id) + gap;
    if (need > left) break;
    show.add(id);
    left -= need;
  }
  return { shown: ids.filter((id) => show.has(id)), overflow: ids.filter((id) => !show.has(id)) };
}

/** A button of the bar as the drag sees it: its place in the list and its box. */
export interface SlotBox {
  /** Index in the user's list (`settings.topbar`). */
  index: number;
  left: number;
  width: number;
  /** The slot the dragged button itself holds. */
  own?: boolean;
}

/** The pointer is over the slot the dragged button already holds: keep the target. */
export const KEEP_SLOT = "keep" as const;

/**
 * Where a button dropped at `x` would go: the list index it would stand before,
 * `KEEP_SLOT` over its own slot, or null with no button to go by. Past either
 * end it goes to that end; over a button — before or after it, by its middle.
 * `boxes` are the laid-out buttons, left to right.
 */
export function topbarSlot(x: number, boxes: readonly SlotBox[]): number | typeof KEEP_SLOT | null {
  if (boxes.length === 0 || !Number.isFinite(x)) return null;
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  if (x < first.left) return first.own ? KEEP_SLOT : first.index;
  for (const box of boxes) {
    if (x >= box.left + box.width) continue;
    // Over this button, or in the gap just before it.
    if (box.own) return KEEP_SLOT;
    return x < box.left + box.width / 2 ? box.index : box.index + 1;
  }
  return last.own ? KEEP_SLOT : last.index + 1;
}

/** Whether two drag targets are the same slot. */
export const sameSlot = (a: number | null, b: number | null): boolean => a === b;
