// Dragging a terminal tab (v1.2): along its strip, into another pane's strip, or
// onto a pane's body — the middle to join that pane, an edge to open a new pane
// there. Pointer-based like every other drag in the app (native HTML5 DnD is
// unreliable in WKWebView, see actions/drag), and built like the dock-tab drag
// next door (dockdrag.svelte.ts).
//
// One drag at a time, app-wide: the strip a tab leaves, the strip or pane it
// hovers and the one it lands in are different parts of the page. The page only
// marks its targets — `data-tabstrip` (a pane id, or `*` for the single strip of
// the broadcast view) with `data-tab` children, `data-pane-body` on what a pane
// shows, `data-pane` on the whole pane — and reads `tabDrag` to draw the preview.
// Where a drop lands is decided by the pure model (`../splitlayout.ts`).
//
// A tab let go of **outside the window** moves to another one: the window of
// the app it was dropped on (v1.4, ADR 0018), or a window of its own (v1.3,
// ADR 0017). The store only notices where the pointer is — what happens then is
// the page's (`onTabDraggedOutside`): it owns the handoff. Pointer events end
// at the window's edge, and the window out there hears nothing of this drag, so
// while the tab is held outside the page is told (`over`), and tells the
// backend, which tells the window under the pointer — that window draws the tab
// (`tabincoming.svelte.ts`). What is said about one drag is said in the order it
// happened: a move, then the next, then the release or the return.
//
// **The layout changes once, on release.** While a tab is in the air the strips
// draw the order the drop would give (`previewTabs`) and a tint shows the half
// of a pane it would take. Moving the tab for real on every pointer move would
// resize terminals mid-drag — a `SIGWINCH` per pixel for the programs in them.

import { holdSelection, layoutBox, passedThreshold, slotIndex } from "../actions/drag";
import {
  canSplit,
  dropChanges,
  findPane,
  paneZone,
  zoneRect,
  type PaneZone,
  type Rect,
  type TabDrop,
} from "../splitlayout";
import { releasedOutside } from "../tabhandoff";
import { dropTab, tabsState } from "./tabs.svelte";

export const tabDrag = $state<{
  /** The tab (session id) being dragged; null while nothing is — a press is not a drag yet. */
  tab: string | null;
  /** The pointer, in viewport px — the floating label hangs from it. */
  x: number;
  y: number;
  /** Where the tab would land right now; null over anything that is not a target. */
  over: TabDrop | null;
  /** The part of a pane a drop on its body would give the tab, viewport px. */
  zone: Rect | null;
  /** The pointer has left the window: letting go now moves the tab to another one. */
  outside: boolean;
  /**
   * Outside: the other window of the app the pointer is over (its label) — it
   * draws the tab, and the tab would land in it. Null — over anything else: it
   * gets a window of its own.
   */
  window: string | null;
}>({ tab: null, x: 0, y: 0, over: null, zone: null, outside: false, window: null });

/** Where on the screen a tab was let go of outside the window (screen px). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** What a tab dragged outside the window does — the page's part of the drag. */
export interface OutsideDrag {
  /** It was let go of outside, at this point of the screen. */
  release: (tab: string, at: ScreenPoint) => void;
  /**
   * It is held outside (called as the pointer moves there). Resolves with the
   * label of the other window of the app it is over — `tabDrag.window` — or null.
   */
  over?: (tab: string) => Promise<string | null>;
  /** It is no longer held outside, and was not let go of there. */
  left?: () => void;
}

let outsideDrag: OutsideDrag | null = null;

/**
 * What a tab dragged outside the window does. Null (the default) — nothing:
 * leaving the window with a tab is not a drop target, as before windows.
 */
export function onTabDraggedOutside(drag: OutsideDrag | null): void {
  outsideDrag = drag;
}

// What is said about a drag is said in order. `over` goes out one at a time: a
// move made while one is out is told once it is answered — so the place the
// pointer stopped at is always told, without a call per pixel. `left` and the
// release wait for the one that is out. Told out of order, the window out there
// would be handed a tab's last position after being told it had gone.
let telling: Promise<void> | null = null;
let tellAgain = false;
/** `over` was said in this drag and not taken back by `left` or a release. */
let told = false;

function tellOver(): void {
  const drag = candidate;
  const over = outsideDrag?.over;
  if (!over || !drag || !tabDrag.outside) return;
  if (telling) {
    tellAgain = true;
    return;
  }
  told = true;
  const said: Promise<void> = over(drag.tab)
    .catch(() => null)
    .then((label) => {
      if (telling === said) telling = null;
      // Not for a drag that ended, or came back inside, while this was out.
      if (candidate === drag && tabDrag.outside) tabDrag.window = label;
      if (tellAgain) {
        tellAgain = false;
        tellOver();
      }
    });
  telling = said;
}

/** Run `next` once what is being said about the drag has been said. */
function afterTelling(next: () => void): void {
  tellAgain = false;
  if (telling) void telling.then(next);
  else next();
}

/** The tab is not held outside any more — say so, if anything was said of it. */
function tellLeft(): void {
  if (!told) return;
  told = false;
  const left = outsideDrag?.left;
  afterTelling(() => left?.());
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

interface Candidate {
  tab: string;
  startX: number;
  startY: number;
  el: HTMLElement;
  pointerId: number;
}

let candidate: Candidate | null = null;
let swallowClick = false;

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** What a point is over: a drop target and, for a pane's body, the tint to draw. */
export interface TabHit {
  drop: TabDrop;
  zone: Rect | null;
}

/**
 * The drop target under a point.
 *
 * Over a strip the slot is decided from the layout boxes of its other tabs, not
 * their drawn ones: a neighbour that is still sliding out of the way must
 * already count as moved (see `layoutBox`), or it is swapped straight back.
 *
 * Over a pane's body the zone is where in the body the pointer is; an edge is
 * offered only while the pane is big enough to be split there.
 */
export function tabDropAt(x: number, y: number, tab: string): TabHit | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  const el = document.elementFromPoint(x, y);
  const strip = el?.closest<HTMLElement>("[data-tabstrip]");
  if (strip) {
    const pane = strip.dataset.tabstrip ?? "";
    const others = [...strip.querySelectorAll<HTMLElement>("[data-tab]")]
      .filter((t) => t.dataset.tab !== tab)
      .map((t) => {
        const box = layoutBox(t);
        return { start: box.left, size: box.width };
      });
    const index = slotIndex(x, others);
    return {
      drop: pane === "*" ? { kind: "flat", index } : { kind: "strip", pane, index },
      zone: null,
    };
  }
  const body = el?.closest<HTMLElement>("[data-pane-body]");
  const pane = body?.dataset.paneBody;
  if (!body || !pane) return null;
  const rect = toRect(body.getBoundingClientRect());
  const whole = [...document.querySelectorAll<HTMLElement>("[data-pane]")].find(
    (p) => p.dataset.pane === pane,
  );
  let zone: PaneZone = paneZone(rect, x, y);
  if (zone !== "center" && !canSplit(whole ? toRect(whole.getBoundingClientRect()) : rect, zone)) {
    zone = "center";
  }
  // A pane with no tabs is the only pane there is, and it is not split: the tab
  // becomes its first (`placeTab`). Only a tab from another window can meet one.
  if (findPane(tabsState.center, pane)?.tabs.length === 0) zone = "center";
  return { drop: { kind: "pane", pane, zone }, zone: zoneRect(rect, zone) };
}

function clearDrag(): void {
  tabDrag.tab = null;
  tabDrag.over = null;
  tabDrag.zone = null;
  tabDrag.outside = false;
  tabDrag.window = null;
}

function stopListening(): void {
  // A drag that ends any way but by a release outside is no longer held there.
  tellLeft();
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  if (candidate && tabDrag.tab !== null) {
    try {
      candidate.el.releasePointerCapture(candidate.pointerId);
    } catch {
      /* already released */
    }
  }
  candidate = null;
}

function onMove(e: PointerEvent): void {
  if (!candidate) return;
  if (tabDrag.tab === null) {
    if (!passedThreshold(candidate.startX, candidate.startY, e.clientX, e.clientY, 5)) return;
    tabDrag.tab = candidate.tab;
    try {
      candidate.el.setPointerCapture(candidate.pointerId);
    } catch {
      /* the element may be gone; window listeners still see the pointer */
    }
  }
  tabDrag.x = e.clientX;
  tabDrag.y = e.clientY;
  // Outside the window there is no pane to land in — only another window.
  tabDrag.outside = outsideDrag !== null && releasedOutside(e.clientX, e.clientY, viewport());
  if (tabDrag.outside) {
    tabDrag.over = null;
    tabDrag.zone = null;
    tellOver();
    return;
  }
  tabDrag.window = null;
  tellLeft();
  const hit = tabDropAt(e.clientX, e.clientY, candidate.tab);
  // A drop that would change nothing is not offered as a target.
  const offered = hit !== null && dropChanges(tabsState.center, candidate.tab, hit.drop);
  tabDrag.over = offered ? hit.drop : null;
  tabDrag.zone = offered ? hit.zone : null;
}

function onUp(e: PointerEvent): void {
  const tab = tabDrag.tab;
  const over = tabDrag.over;
  // Decided from where the pointer was let go, not from the last move: the
  // release is the gesture.
  const drag = outsideDrag;
  const out = tab !== null && drag !== null && releasedOutside(e.clientX, e.clientY, viewport());
  // Let go of outside, the tab is not "no longer held there" — it was dropped
  // there, and what happens to it is the page's to say.
  if (out) told = false;
  stopListening();
  clearDrag();
  if (tab === null) return;
  // The release also produces a click on the tab the drag started from — it must
  // not activate that tab on top of the move.
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 0);
  if (out && drag) {
    const at = { x: e.screenX, y: e.screenY };
    afterTelling(() => drag.release(tab, at));
    return;
  }
  if (over) dropTab(tab, over);
}

function onCancel(): void {
  stopListening();
  clearDrag();
}

/** Arm a possible drag from a tab's `pointerdown`; it starts once the pointer moves. */
export function beginTabDrag(e: PointerEvent, tab: string): void {
  if (e.button !== 0) return;
  stopListening();
  clearDrag();
  // A call that never came back must not hold up every drag after it.
  telling = null;
  tellAgain = false;
  holdSelection();
  candidate = {
    tab,
    startX: e.clientX,
    startY: e.clientY,
    el: e.currentTarget as HTMLElement,
    pointerId: e.pointerId,
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

/** True once for the click that ends a drag — the tab's `onclick` returns early. */
export function consumeTabDragClick(): boolean {
  const was = swallowClick;
  swallowClick = false;
  return was;
}

/** Abort any drag in progress (tests, and a tab that closes mid-drag). */
export function cancelTabDrag(): void {
  stopListening();
  clearDrag();
  swallowClick = false;
}
