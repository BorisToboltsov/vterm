// Dragging a view of a connection (v1.11.1, ADR 0024): its terminal or a file
// open through it — along its zone's strip, into another zone's strip, or onto
// a zone's body: the middle to join that zone, an edge to open a new zone
// there. The same gesture and the same preview as dragging a session's tab
// between the panes of the centre (`tabdrag.svelte.ts`), one level down.
//
// **A view never leaves its connection.** A file is read and saved through the
// connection it was opened in; outside that connection's area there is nothing
// a drop could mean. So only what lies inside it is a target, and the label
// that follows the pointer stops at its edge (`confinedGhost`) — a label that
// went on past it would say the file could go where it cannot.
//
// The page only marks its targets — `data-views-of` (a session id) on the
// connection's area, `data-viewstrip` (a zone id) with `data-view` children,
// `data-zone-body` on what a zone shows — and reads `viewDrag` to draw the
// preview. Where a drop lands is decided by the pure model (`../splitlayout.ts`).
//
// **The layout changes once, on release.** While a view is in the air the
// strips draw the order the drop would give (`previewTabs`) and a tint shows
// the half of a zone it would take: moving it for real on every pointer move
// would resize the terminal mid-drag — a `SIGWINCH` per pixel for what runs in
// it — and re-lay the editors out under the pointer.

import { holdSelection, layoutBox, passedThreshold, slotIndex } from "../actions/drag";
import {
  canSplit,
  dropChanges,
  paneZone,
  zoneRect,
  type PaneZone,
  type Rect,
  type TabDrop,
} from "../splitlayout";
import { dropSessionView, getWorkspace } from "./workspaces.svelte";

export const viewDrag = $state<{
  /** The connection whose view is being dragged; null while nothing is. */
  session: string | null;
  /** The view in the air: the terminal's id or a file's. A press is not a drag yet. */
  view: string | null;
  /** The pointer, in viewport px. */
  x: number;
  y: number;
  /** Where the view would land right now; null over anything that is not a target. */
  over: TabDrop | null;
  /** The part of a zone a drop on its body would give the view, viewport px. */
  zone: Rect | null;
  /** The connection's area, viewport px: what the view cannot be taken out of. */
  area: Rect | null;
}>({ session: null, view: null, x: 0, y: 0, over: null, zone: null, area: null });

interface Candidate {
  session: string;
  view: string;
  startX: number;
  startY: number;
  el: HTMLElement;
  pointerId: number;
}

let candidate: Candidate | null = null;
let swallowClick = false;

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** The area of a connection on the page — the element its zones are laid out in. */
function areaOf(session: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    [...document.querySelectorAll<HTMLElement>("[data-views-of]")].find(
      (el) => el.dataset.viewsOf === session,
    ) ?? null
  );
}

/** What a point is over: a drop target and, for a zone's body, the tint to draw. */
export interface ViewHit {
  drop: TabDrop;
  zone: Rect | null;
}

/**
 * The drop target under a point, for a view of `session` — and only inside that
 * connection's own area: over another connection, a dock or the strip of
 * sessions there is none.
 *
 * Over a strip the slot is decided from the layout boxes of its other views,
 * not their drawn ones: a neighbour that is still sliding out of the way must
 * already count as moved (see `layoutBox`), or it is swapped straight back.
 *
 * Over a zone's body the place is where in the body the pointer is; an edge is
 * offered only while the zone is big enough to be split there.
 */
export function viewDropAt(x: number, y: number, session: string, view: string): ViewHit | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  const el = document.elementFromPoint(x, y);
  const home = el?.closest<HTMLElement>("[data-views-of]");
  if (!home || home.dataset.viewsOf !== session) return null;
  const strip = el?.closest<HTMLElement>("[data-viewstrip]");
  if (strip) {
    const pane = strip.dataset.viewstrip ?? "";
    const others = [...strip.querySelectorAll<HTMLElement>("[data-view]")]
      .filter((v) => v.dataset.view !== view)
      .map((v) => {
        const box = layoutBox(v);
        return { start: box.left, size: box.width };
      });
    const index = slotIndex(x, others);
    return { drop: { kind: "strip", pane, index }, zone: null };
  }
  const body = el?.closest<HTMLElement>("[data-zone-body]");
  const pane = body?.dataset.zoneBody;
  if (!body || !pane) return null;
  const rect = toRect(body.getBoundingClientRect());
  // The whole zone — its strip and what it shows — is what has to be big
  // enough for two.
  const own = [...home.querySelectorAll<HTMLElement>("[data-viewstrip]")].find(
    (s) => s.dataset.viewstrip === pane,
  );
  const top = own ? Math.min(rect.y, own.getBoundingClientRect().top) : rect.y;
  const whole: Rect = { x: rect.x, y: top, w: rect.w, h: rect.h + (rect.y - top) };
  let zone: PaneZone = paneZone(rect, x, y);
  if (zone !== "center" && !canSplit(whole, zone)) zone = "center";
  return { drop: { kind: "pane", pane, zone }, zone: zoneRect(rect, zone) };
}

function clearDrag(): void {
  viewDrag.session = null;
  viewDrag.view = null;
  viewDrag.over = null;
  viewDrag.zone = null;
  viewDrag.area = null;
}

function stopListening(): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  if (candidate && viewDrag.view !== null) {
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
  if (viewDrag.view === null) {
    if (!passedThreshold(candidate.startX, candidate.startY, e.clientX, e.clientY, 5)) return;
    viewDrag.session = candidate.session;
    viewDrag.view = candidate.view;
    try {
      candidate.el.setPointerCapture(candidate.pointerId);
    } catch {
      /* the element may be gone; window listeners still see the pointer */
    }
  }
  viewDrag.x = e.clientX;
  viewDrag.y = e.clientY;
  holdSelection();
  // Measured on every move: the docks may fold, the window may be resized.
  const area = areaOf(candidate.session);
  viewDrag.area = area ? toRect(area.getBoundingClientRect()) : null;
  const hit = viewDropAt(e.clientX, e.clientY, candidate.session, candidate.view);
  // A drop that would change nothing is not offered as a target.
  const offered =
    hit !== null && dropChanges(getWorkspace(candidate.session).layout, candidate.view, hit.drop);
  viewDrag.over = offered ? hit.drop : null;
  viewDrag.zone = offered ? hit.zone : null;
}

function onUp(): void {
  const session = viewDrag.session;
  const view = viewDrag.view;
  const over = viewDrag.over;
  stopListening();
  clearDrag();
  if (session === null || view === null) return;
  // The release also produces a click on the view the drag started from — it
  // must not show that view on top of the move.
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 0);
  if (over) dropSessionView(session, view, over);
}

function onCancel(): void {
  stopListening();
  clearDrag();
}

/** Arm a possible drag from a view's `pointerdown`; it starts once the pointer moves. */
export function beginViewDrag(e: PointerEvent, session: string, view: string): void {
  if (e.button !== 0) return;
  stopListening();
  clearDrag();
  holdSelection();
  candidate = {
    session,
    view,
    startX: e.clientX,
    startY: e.clientY,
    el: e.currentTarget as HTMLElement,
    pointerId: e.pointerId,
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

/** True once for the click that ends a drag — the view's `onclick` returns early. */
export function consumeViewDragClick(): boolean {
  const was = swallowClick;
  swallowClick = false;
  return was;
}

/** Abort any drag in progress (tests, and a file that closes mid-drag). */
export function cancelViewDrag(): void {
  stopListening();
  clearDrag();
  swallowClick = false;
}
