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
// A tab let go of **outside the window** moves to a window of its own (v1.3,
// ADR 0017). The store only notices where the pointer was released — what
// happens then is the page's (`onTabReleasedOutside`): it owns the handoff.
//
// **The layout changes once, on release.** While a tab is in the air the strips
// draw the order the drop would give (`previewTabs`) and a tint shows the half
// of a pane it would take. Moving the tab for real on every pointer move would
// resize terminals mid-drag — a `SIGWINCH` per pixel for the programs in them.

import { layoutBox, passedThreshold, slotIndex } from "../actions/drag";
import {
  canSplit,
  dropChanges,
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
  /** The pointer has left the window: letting go now moves the tab to a new one. */
  outside: boolean;
}>({ tab: null, x: 0, y: 0, over: null, zone: null, outside: false });

/** Where on the screen a tab was let go of outside the window (screen px). */
export interface ScreenPoint {
  x: number;
  y: number;
}

let releaseOutside: ((tab: string, at: ScreenPoint) => void) | null = null;

/**
 * What a tab released outside the window does. Null (the default) — nothing:
 * the drag just ends, as it did before windows.
 */
export function onTabReleasedOutside(
  handler: ((tab: string, at: ScreenPoint) => void) | null,
): void {
  releaseOutside = handler;
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
  return { drop: { kind: "pane", pane, zone }, zone: zoneRect(rect, zone) };
}

function clearDrag(): void {
  tabDrag.tab = null;
  tabDrag.over = null;
  tabDrag.zone = null;
  tabDrag.outside = false;
}

function stopListening(): void {
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
    // Drop a selection that slipped in before the drag was recognised.
    window.getSelection()?.removeAllRanges();
  }
  tabDrag.x = e.clientX;
  tabDrag.y = e.clientY;
  // Outside the window there is no pane to land in — only "a window of its own".
  tabDrag.outside = releaseOutside !== null && releasedOutside(e.clientX, e.clientY, viewport());
  if (tabDrag.outside) {
    tabDrag.over = null;
    tabDrag.zone = null;
    return;
  }
  const hit = tabDropAt(e.clientX, e.clientY, candidate.tab);
  // A drop that would change nothing is not offered as a target.
  const offered = hit !== null && dropChanges(tabsState.center, candidate.tab, hit.drop);
  tabDrag.over = offered ? hit.drop : null;
  tabDrag.zone = offered ? hit.zone : null;
}

function onUp(e: PointerEvent): void {
  const tab = tabDrag.tab;
  const over = tabDrag.over;
  stopListening();
  clearDrag();
  if (tab === null) return;
  // The release also produces a click on the tab the drag started from — it must
  // not activate that tab on top of the move.
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 0);
  // Decided from where the pointer was let go, not from the last move: the
  // release is the gesture.
  if (releaseOutside && releasedOutside(e.clientX, e.clientY, viewport())) {
    releaseOutside(tab, { x: e.screenX, y: e.screenY });
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
