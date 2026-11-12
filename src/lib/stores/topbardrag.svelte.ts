// Dragging a button along the top bar to reorder it (v1.16). Pointer-based like
// every other drag in the app, and built like the dock-tab drag next to it
// (`dockdrag.svelte.ts`): a press is not a drag until the pointer has moved;
// while the button is in the air the bar draws the order the drop would give
// (`previewTopbar`), so its neighbours slide apart; the list itself changes
// once, on release (`moveAction`).
//
// The bar only marks its buttons (`data-topbar`, `data-topbar-pin`,
// `data-topbar-own`) and reads `topbarDrag` to draw the preview and the copy at
// the pointer; where a drop lands is decided by the pure model (`topbarSlot`).
//
// v1.35, two more ends to a drag: a button let go away from the bar is taken
// off it (`removing` while it would be — never Utilities or Settings), and a
// tool or a session action is dragged in from the Utilities window (`incoming`:
// not on the bar yet, so it is pinned where it lands, and nothing happens away
// from the bar).

import { swallowed } from "../api/diag";
import {
  cancelOnEscape,
  holdSelection,
  layoutBox,
  passedThreshold,
  swallowReleaseClick,
} from "../actions/drag";
import { settings, uiPx } from "../settings/settings.svelte";
import {
  canUnpin,
  KEEP_SLOT,
  moveChanges,
  sameSlot,
  TOPBAR_SIZES,
  topbarSlot,
  type SlotBox,
  type TopbarId,
} from "../topbar/topbaractions";
import { actionLabel } from "../topbar/topbarui";
import { t } from "../i18n";
import { moveAction, pinActionAt, unpinAction } from "./topbarpins.svelte";
import { notifyInfo } from "./toasts.svelte";

export const topbarDrag = $state<{
  /** The button being dragged; null while nothing is (a press is not a drag yet). */
  id: TopbarId | null;
  /** Where the copy at the pointer is drawn: its top-left corner, in viewport px. */
  x: number;
  y: number;
  /** Size of the button that was picked up — the copy keeps it. */
  width: number;
  height: number;
  /** The list index it would stand before right now; null — it would not move. */
  over: number | null;
  /** Let go now, it would be taken off the bar. */
  removing: boolean;
  /** It comes from the Utilities window: not on the bar yet. */
  incoming: boolean;
}>({ id: null, x: 0, y: 0, width: 0, height: 0, over: null, removing: false, incoming: false });

interface Candidate {
  id: TopbarId;
  startX: number;
  startY: number;
  /** Pointer position inside the button at the press — the copy hangs from there. */
  grabX: number;
  grabY: number;
  el: HTMLElement;
  pointerId: number;
}

let candidate: Candidate | null = null;
let swallowClick = false;
let stopEscape: (() => void) | null = null;

/** How far above or below the bar the pointer may stray and still aim at it, px. */
const REACH = 32;

/**
 * Where a button dropped at this point would go: a list index, `KEEP_SLOT` over
 * the slot it already holds, or null away from the bar. Buttons are matched by
 * their layout boxes, not their drawn ones: a neighbour that is still sliding
 * out of the way must already count as moved (see `layoutBox`).
 */
export function topbarDropAt(x: number, y: number): number | typeof KEEP_SLOT | null {
  if (typeof document === "undefined") return null;
  const bar = document.querySelector<HTMLElement>("[data-topbar]");
  if (!bar) return null;
  const area = layoutBox(bar);
  if (y < area.top - REACH || y > area.top + area.height + REACH) return null;
  const boxes: SlotBox[] = [];
  for (const el of bar.querySelectorAll<HTMLElement>("[data-topbar-pin]")) {
    const index = Number(el.dataset.topbarPin);
    if (!Number.isInteger(index)) continue;
    const box = layoutBox(el);
    boxes.push({ index, left: box.left, width: box.width, own: el.dataset.topbarOwn !== undefined });
  }
  return topbarSlot(x, boxes);
}

function clearDrag(): void {
  topbarDrag.id = null;
  topbarDrag.over = null;
  topbarDrag.removing = false;
  topbarDrag.incoming = false;
}

function stopListening(): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  stopEscape?.();
  stopEscape = null;
  if (candidate && topbarDrag.id !== null) {
    try {
      candidate.el.releasePointerCapture(candidate.pointerId);
    } catch (e) {
      /* already released */
      swallowed("app", "the pointer was not released", e);
    }
  }
  candidate = null;
}

function onMove(e: PointerEvent): void {
  if (!candidate) return;
  if (topbarDrag.id === null) {
    if (!passedThreshold(candidate.startX, candidate.startY, e.clientX, e.clientY, 5)) return;
    topbarDrag.id = candidate.id;
    try {
      candidate.el.setPointerCapture(candidate.pointerId);
    } catch (e) {
      /* the element may be gone; window listeners still see the pointer */
      swallowed("app", "the pointer was not captured: the drag follows it from the window", e);
    }
  }
  topbarDrag.x = e.clientX - candidate.grabX;
  topbarDrag.y = e.clientY - candidate.grabY;
  const over = topbarDropAt(e.clientX, e.clientY);
  const pinned = settings.topbar.includes(candidate.id);
  const removing = pinned && over === null && canUnpin(candidate.id);
  if (topbarDrag.removing !== removing) topbarDrag.removing = removing;
  if (over === KEEP_SLOT) return;
  // A drop that would change nothing is not offered as a target; one from
  // outside the bar changes it wherever it lands.
  const next = over !== null && (!pinned || moveChanges(settings.topbar, candidate.id, over)) ? over : null;
  // Written only when it is another slot: rewriting it restarts the slides.
  if (!sameSlot(topbarDrag.over, next)) topbarDrag.over = next;
}

function onUp(): void {
  const id = topbarDrag.id;
  const over = topbarDrag.over;
  const removing = topbarDrag.removing;
  stopListening();
  if (id === null) return;
  // The release also produces a click on the button the drag started from — it
  // must not open Settings on top of the move.
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 0);
  clearDrag();
  if (over !== null) {
    if (settings.topbar.includes(id)) moveAction(id, over);
    else pinActionAt(id, over);
  } else if (removing) {
    unpinAction(id);
    // Said where it can come back from: the bar's own menu has every button.
    notifyInfo(t("topbar.removed", { name: actionLabel(id, settings.topbarCommands) }), { source: "settings" });
  }
}

function onCancel(): void {
  stopListening();
  clearDrag();
}

/**
 * Arm a possible drag from a button's `pointerdown`; it starts once the pointer
 * moves. From a row of the Utilities window (`incoming`) the copy at the pointer
 * is the bar's button, not the row: it hangs from its middle.
 */
export function beginTopbarDrag(e: PointerEvent, id: TopbarId, incoming = false): void {
  if (e.button !== 0) return;
  // From the window, only what is not on the bar yet: the bar reorders its own.
  if (incoming && settings.topbar.includes(id)) return;
  stopListening();
  clearDrag();
  const el = e.currentTarget as HTMLElement;
  const box = el.getBoundingClientRect();
  holdSelection();
  const size = uiPx(TOPBAR_SIZES.icon);
  candidate = {
    id,
    startX: e.clientX,
    startY: e.clientY,
    grabX: incoming ? size / 2 : e.clientX - box.left,
    grabY: incoming ? size / 2 : e.clientY - box.top,
    el,
    pointerId: e.pointerId,
  };
  topbarDrag.width = incoming ? size : box.width;
  topbarDrag.height = incoming ? size : box.height;
  topbarDrag.incoming = incoming;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  // `Esc` puts the button back where it was.
  stopEscape = cancelOnEscape(
    () => topbarDrag.id !== null,
    () => {
      cancelTopbarDrag();
      swallowReleaseClick((on) => (swallowClick = on));
    },
  );
}

/** True once for the click that ends a drag — the bar swallows that click. */
export function consumeTopbarClick(): boolean {
  const was = swallowClick;
  swallowClick = false;
  return was;
}

/** Abort any drag in progress (tests, and a bar that unmounts mid-drag). */
export function cancelTopbarDrag(): void {
  stopListening();
  clearDrag();
  swallowClick = false;
}
