// Dragging a tool-panel tab between docks (v1.1). Pointer-based like every other
// drag in the app (native HTML5 DnD is unreliable in WKWebView, see actions/drag).
//
// One drag at a time, app-wide, so the state lives here rather than in a dock:
// the tab that starts the drag, the dock it hovers and the dock it lands in are
// three different component instances. The docks only mark themselves as drop
// targets (`data-dock-drop`, `data-dock-tab`, `data-dock-axis`) and read
// `dockDrag` to draw the preview; where a drop lands is decided by the pure
// model (`insertionIndex`/`movePanel` in ../docklayout.ts).
//
// While a tab is in the air the strips draw the order the drop would give
// (`previewPanels`), so the other tabs slide apart to make room. The layout
// itself changes once, on release.

import { holdSelection, layoutBox, passedThreshold, type Box } from "../actions/drag";
import {
  dropChanges,
  insertionIndex,
  isDockSide,
  sameTarget,
  type DropTarget,
  type PanelId,
} from "../docklayout";
import { MOTION_FAST, motion } from "../motion";
import { layout, movePanel } from "./layout.svelte";

export const dockDrag = $state<{
  /** The panel being dragged; null while nothing is (a press is not a drag yet). */
  panel: PanelId | null;
  /** Where the dragged tab is drawn: its top-left corner, in viewport px. */
  x: number;
  y: number;
  /** Size of the tab that was picked up — the floating copy keeps it. */
  width: number;
  height: number;
  /** The tab came from a collapsed dock's rail (its label is set vertically). */
  vertical: boolean;
  /** Where it would land right now, or null over anything that is not a dock. */
  over: DropTarget | null;
  /** Released: the copy is gliding to its slot and no longer follows the pointer. */
  settling: boolean;
}>({
  panel: null,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  vertical: false,
  over: null,
  settling: false,
});

interface Candidate {
  panel: PanelId;
  startX: number;
  startY: number;
  /** Pointer position inside the tab at the press — the copy hangs from there. */
  grabX: number;
  grabY: number;
  el: HTMLElement;
  pointerId: number;
}

let candidate: Candidate | null = null;
let swallowClick = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

/** Keep the current target: the pointer is over the slot the tab already holds. */
const KEEP = "keep" as const;

/** The dock's tabs that are laid out right now (its rail or its strip, not both). */
function laidOutTabs(dock: HTMLElement): HTMLElement[] {
  const all = [...dock.querySelectorAll<HTMLElement>("[data-dock-tab]")];
  // jsdom lays nothing out (offsetParent is always null) — there every tab counts.
  const shown = all.filter((el) => el.offsetParent !== null);
  return shown.length > 0 ? shown : all;
}

/**
 * The drop target under a point: the dock (`data-dock-drop`) and, when the point
 * is over one of its tabs, the gap before or after that tab. A tab carries its
 * index in the dock's full panel list (`data-dock-tab`), so the result can go
 * straight to `movePanel` even while some of the dock's panels are not shown.
 *
 * Tabs are matched by their layout boxes, not their drawn ones: a neighbour that
 * is still sliding out of the way must already count as moved (see `layoutBox`).
 * Over the dragged tab's own slot the answer is `"keep"` — the slot is where the
 * tab would land already, and re-deciding from an empty box makes the gap jump.
 */
export function dockDropAt(x: number, y: number): DropTarget | typeof KEEP | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  const dock = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-dock-drop]");
  const side = dock?.dataset.dockDrop;
  if (!dock || !isDockSide(side)) return null;
  for (const tab of laidOutTabs(dock)) {
    const box = layoutBox(tab);
    const vertical = tab.closest<HTMLElement>("[data-dock-axis]")?.dataset.dockAxis === "y";
    const [pos, start, size] = vertical ? [y, box.top, box.height] : [x, box.left, box.width];
    if (pos < start || pos >= start + size) continue;
    // Along the strip's axis the pointer is in this tab's slot; across it the
    // pointer may be anywhere in the dock — a tab is easier to hit that way.
    if (tab.dataset.dockPlaceholder !== undefined) return KEEP;
    const index = Number(tab.dataset.dockTab);
    if (!Number.isInteger(index)) continue;
    return { side, index: insertionIndex(pos, start, size, index) };
  }
  return { side, index: null };
}

function clearDrag(): void {
  clearTimeout(settleTimer);
  settleTimer = undefined;
  dockDrag.panel = null;
  dockDrag.over = null;
  dockDrag.settling = false;
}

function stopListening(): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  if (candidate && dockDrag.panel !== null) {
    try {
      candidate.el.releasePointerCapture(candidate.pointerId);
    } catch {
      /* already released */
    }
  }
  candidate = null;
}

function onMove(e: PointerEvent): void {
  if (!candidate || dockDrag.settling) return;
  if (dockDrag.panel === null) {
    if (!passedThreshold(candidate.startX, candidate.startY, e.clientX, e.clientY, 5)) return;
    dockDrag.panel = candidate.panel;
    try {
      candidate.el.setPointerCapture(candidate.pointerId);
    } catch {
      /* the element may be gone; window listeners still see the pointer */
    }
  }
  dockDrag.x = e.clientX - candidate.grabX;
  dockDrag.y = e.clientY - candidate.grabY;
  const over = dockDropAt(e.clientX, e.clientY);
  if (over === KEEP) return;
  // A drop that would change nothing is not offered as a target.
  const next = over && dropChanges(layout.docks, candidate.panel, over) ? over : null;
  // Written only when it is another target: over a dock's body the answer is
  // the same on every move, and rewriting it started the strips' slides over.
  if (!sameTarget(dockDrag.over, next)) dockDrag.over = next;
}

/** The slot the dragged tab holds in the strips right now, if it is laid out. */
function placeholderBox(): Box | null {
  if (typeof document === "undefined") return null;
  const slots = [...document.querySelectorAll<HTMLElement>("[data-dock-placeholder]")];
  const el = slots.find((s) => s.offsetParent !== null);
  return el ? layoutBox(el) : null;
}

function onUp(): void {
  const panel = dockDrag.panel;
  const over = dockDrag.over;
  stopListening();
  if (panel === null) return;
  // The release also produces a click on the tab the drag started from — it must
  // not switch tabs or expand a dock on top of the move.
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 0);

  // Let the copy glide into the slot the strip already holds open for it, then
  // hand over to the real tab. Skipped when there is no slot to glide to (the
  // drop opens a collapsed dock or lands on a window edge — the layout under the
  // copy is about to change), and under reduced motion.
  const duration = motion(MOTION_FAST).duration;
  const lands = !over || !layout.docks[over.side].collapsed;
  const slot = lands ? placeholderBox() : null;
  if (over) movePanel(panel, over.side, over.index);
  if (!slot || duration === 0) {
    clearDrag();
    return;
  }
  // The move is done; what is left is the copy's last few pixels. With no target
  // the strips draw the layout as it now is, the tab's slot still held open.
  dockDrag.over = null;
  dockDrag.settling = true;
  dockDrag.x = slot.left;
  dockDrag.y = slot.top;
  settleTimer = setTimeout(clearDrag, duration);
}

function onCancel(): void {
  stopListening();
  clearDrag();
}

/** Arm a possible drag from a tab's `pointerdown`; it starts once the pointer moves. */
export function beginPanelDrag(e: PointerEvent, panel: PanelId): void {
  if (e.button !== 0) return;
  stopListening();
  clearDrag();
  const el = e.currentTarget as HTMLElement;
  const box = el.getBoundingClientRect();
  holdSelection();
  candidate = {
    panel,
    startX: e.clientX,
    startY: e.clientY,
    grabX: e.clientX - box.left,
    grabY: e.clientY - box.top,
    el,
    pointerId: e.pointerId,
  };
  dockDrag.width = box.width;
  dockDrag.height = box.height;
  dockDrag.vertical = el.closest<HTMLElement>("[data-dock-axis]")?.dataset.dockAxis === "y";
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

/** True once for the click that ends a drag — the tab's `onclick` returns early. */
export function consumeDragClick(): boolean {
  const was = swallowClick;
  swallowClick = false;
  return was;
}

/** Abort any drag in progress (tests, and a dock that unmounts mid-drag). */
export function cancelPanelDrag(): void {
  stopListening();
  clearDrag();
  swallowClick = false;
}
