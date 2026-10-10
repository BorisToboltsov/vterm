// Dragging files (v1.13): out of a file panel — onto a folder of another
// session's panel, onto a session's tab or terminal, into another window of the
// app — and, the same store from the other end, files the system drags over
// the window from the desktop, or another window of the app holds over this one.
//
// **The drag is the store's, not the panel's.** A session's file panel is
// destroyed whenever its tab stops being on screen, and holding files over a
// tab is exactly what puts another tab on screen: a drag kept in the panel
// ended the moment it reached somewhere. So the panel only says what is picked
// up; the pointer, the target and the release live here, like a tab's drag.
//
// The page marks what files can be dropped on — `data-file-panel` (a session
// id) on a file panel, `data-drop` (a folder) on its rows and `data-file-cwd`
// on its list, `data-tab` on a session's tab, `data-views-of` on a connection's
// area — and tells the store, through `onFileDrag`, what a drop there means and
// what to do about it. What a drop means is decided by the pure model
// (`../filedrop.ts`).
//
// **Nothing happens until the release.** While files are in the air the page
// only draws: the label at the pointer, the target under it. The one thing a
// held drag does is open what it is held over — a tab, the dock's Files tab —
// after `SPRING_MS`: without that a panel behind another tab could not be
// reached at all.

import {
  cancelOnEscape,
  holdSelection,
  passedThreshold,
  swallowReleaseClick,
} from "../actions/drag";
import {
  sameTarget,
  SPRING_MS,
  type CarriedFiles,
  type DropMeaning,
  type FileTarget,
} from "../filedrop";
import { sameRect, type Rect } from "../splitlayout";
import { releasedOutside } from "../tabhandoff";

export const fileDrag = $state<{
  /** What is in the air; null while nothing is — a press is not a drag yet. */
  files: CarriedFiles | null;
  /** The pointer, in viewport px — the label hangs from it. */
  x: number;
  y: number;
  /** What a release would land on right now; null over anything that is not a target. */
  over: FileTarget | null;
  /** A session's area a release would land on, viewport px — tinted while it is the target. */
  zone: Rect | null;
  /** The pointer has left the window. */
  outside: boolean;
  /** Outside: the other window of the app it is over — that window draws the files. */
  window: string | null;
  /** Over none of the app's windows: a floating label draws them, not this page. */
  floating: boolean;
  /**
   * They are drawn here on someone else's word: files of another window held
   * over this one, or files the system drags in from the desktop. This page
   * does not own the pointer — it is told where it is.
   */
  guest: boolean;
}>({
  files: null,
  x: 0,
  y: 0,
  over: null,
  zone: null,
  outside: false,
  window: null,
  floating: false,
  guest: false,
});

/** What can open under held files: a session's tab, or the dock's Files tab. */
export type Spring = { kind: "tab"; id: string } | { kind: "files" };

/** Where the backend says dragged files are, outside this window. */
export interface FileSight {
  window: string | null;
  floating: boolean;
}

/** The page's part of a file drag. */
export interface FileDragHost {
  /** What a release over `target` would do; null — it is not a target for these files. */
  meaning: (files: CarriedFiles, target: FileTarget) => DropMeaning | null;
  /** The files were let go of over a target. */
  drop: (files: CarriedFiles, meaning: DropMeaning) => void;
  /** Files were held over it long enough: open it. */
  spring: (what: Spring) => void;
  /** Outside the window: say so, and learn where they are (another window, the desktop). */
  over?: (files: CarriedFiles) => Promise<FileSight | null>;
  /** Let go of away from this window's targets, over another window or outside. */
  release?: (files: CarriedFiles) => void;
  /** No longer held outside, and not let go of there. */
  left?: () => void;
}

let host: FileDragHost | null = null;

/** What dragged files do in this window. Null — nothing: no drop is a drop. */
export function onFileDrag(next: FileDragHost | null): void {
  host = next;
}

interface Candidate {
  /** What is picked up, asked once the pointer has moved far enough to mean it. */
  pick: () => CarriedFiles | null;
  startX: number;
  startY: number;
  el: HTMLElement;
  pointerId: number;
}

let candidate: Candidate | null = null;
let swallowClick = false;
let stopEscape: (() => void) | null = null;

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

/** What a point is over: a target and, for a session's area, the tint to draw. */
export interface FileHit {
  target: FileTarget;
  zone: Rect | null;
}

/**
 * What files held at a point would be dropped on: a folder row of a file
 * panel, the folder its list shows, the panel as a whole (it lists nothing —
 * not connected yet), a session's tab, or a session's area in the centre.
 */
export function fileTargetAt(x: number, y: number): FileHit | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const panel = el.closest<HTMLElement>("[data-file-panel]");
  const session = panel?.dataset.filePanel;
  if (panel && session) {
    const row = el.closest<HTMLElement>("[data-drop]");
    if (row && panel.contains(row)) {
      return { target: { kind: "folder", session, dir: row.dataset.drop ?? "" }, zone: null };
    }
    const list = el.closest<HTMLElement>("[data-file-cwd]");
    const dir = list?.dataset.fileCwd;
    if (list && dir && panel.contains(list)) {
      return { target: { kind: "folder", session, dir }, zone: null };
    }
    return { target: { kind: "session", session }, zone: null };
  }
  const tab = el.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (tab) return { target: { kind: "session", session: tab }, zone: null };
  const area = el.closest<HTMLElement>("[data-views-of]");
  const of = area?.dataset.viewsOf;
  if (area && of) {
    return { target: { kind: "session", session: of }, zone: toRect(area.getBoundingClientRect()) };
  }
  return null;
}

/** What would open if files were held at a point. */
export function springAt(x: number, y: number): Spring | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  const el = document.elementFromPoint(x, y);
  const tab = el?.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (tab) return { kind: "tab", id: tab };
  if (el?.closest('[data-dock-panel="files"]')) return { kind: "files" };
  return null;
}

// ── Opening what files are held over ────────────────────────────────────────

let springKey: string | null = null;
let springTimer: ReturnType<typeof setTimeout> | undefined;

function hold(what: Spring | null): void {
  const key = what === null ? null : what.kind === "tab" ? `tab:${what.id}` : "files";
  if (key === springKey) return;
  clearTimeout(springTimer);
  springKey = key;
  if (what === null) return;
  springTimer = setTimeout(() => {
    // Still held over it: the timer is dropped whenever the key changes.
    if (fileDrag.files !== null) host?.spring(what);
  }, SPRING_MS);
}

// ── Where the files would land ──────────────────────────────────────────────

/**
 * Say what a release would land on — written only when that is something else:
 * a row redrawn for the same target on every pointer move restarts whatever is
 * drawn from it (see `offer` in tabdrag.svelte.ts).
 */
function offer(hit: FileHit | null): void {
  const target = hit?.target ?? null;
  const zone = hit?.zone ?? null;
  if (!sameTarget(fileDrag.over, target)) fileDrag.over = target;
  if (!sameRect(fileDrag.zone, zone)) fileDrag.zone = zone;
}

/** Look at what is under the point and offer it, if a drop there means anything. */
function aim(x: number, y: number): void {
  const files = fileDrag.files;
  if (!files) return;
  fileDrag.x = x;
  fileDrag.y = y;
  hold(springAt(x, y));
  const hit = fileTargetAt(x, y);
  offer(hit !== null && host?.meaning(files, hit.target) ? hit : null);
}

function clearDrag(): void {
  hold(null);
  fileDrag.files = null;
  fileDrag.over = null;
  fileDrag.zone = null;
  fileDrag.outside = false;
  fileDrag.window = null;
  fileDrag.floating = false;
  fileDrag.guest = false;
}

/** Let go: do what the target under the files means, and end the drag. */
function land(): void {
  const files = fileDrag.files;
  const target = fileDrag.over;
  clearDrag();
  if (!files || !target || !host) return;
  const meaning = host.meaning(files, target);
  if (meaning) host.drop(files, meaning);
}

// ── Outside the window ──────────────────────────────────────────────────────
// As for a tab (`tabdrag.svelte.ts`): the backend is told where the files are,
// one word at a time, and answers with the window under the pointer. Whatever
// was said is taken back — once — when the drag ends any other way than a
// release out there.

let telling: Promise<void> | null = null;
let tellAgain = false;
let told = false;

function tellOver(): void {
  const drag = candidate;
  const files = fileDrag.files;
  const over = host?.over;
  if (!over || !drag || !files) return;
  if (telling) {
    tellAgain = true;
    return;
  }
  told = true;
  const said: Promise<void> = over(files)
    .catch(() => null)
    .then((sight) => {
      if (telling === said) telling = null;
      if (candidate === drag && fileDrag.files !== null) {
        fileDrag.window = sight?.window ?? null;
        fileDrag.floating = sight?.floating ?? false;
        // Another window lies under the pointer: nothing here is the target.
        if (fileDrag.window !== null) offer(null);
      }
      if (tellAgain) {
        tellAgain = false;
        tellOver();
      }
    });
  telling = said;
}

function afterTelling(next: () => void): void {
  tellAgain = false;
  if (telling) void telling.then(next);
  else next();
}

function tellLeft(): void {
  if (!told) return;
  told = false;
  const left = host?.left;
  afterTelling(() => left?.());
}

// ── The pointer ─────────────────────────────────────────────────────────────

function stopListening(): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  stopEscape?.();
  stopEscape = null;
  if (candidate && fileDrag.files !== null) {
    try {
      candidate.el.releasePointerCapture(candidate.pointerId);
    } catch {
      /* already released, or the panel it belonged to is gone */
    }
  }
  candidate = null;
}

function onMove(e: PointerEvent): void {
  if (!candidate) return;
  if (fileDrag.files === null) {
    if (!passedThreshold(candidate.startX, candidate.startY, e.clientX, e.clientY, 5)) return;
    const files = candidate.pick();
    if (!files || files.entries.length === 0) return cancelFileDrag();
    fileDrag.files = files;
    fileDrag.guest = false;
    try {
      candidate.el.setPointerCapture(candidate.pointerId);
    } catch {
      /* the element may be gone; window listeners still see the pointer */
    }
  }
  holdSelection();
  fileDrag.outside = releasedOutside(e.clientX, e.clientY, viewport());
  tellOver();
  if (fileDrag.outside || fileDrag.window !== null) {
    fileDrag.x = e.clientX;
    fileDrag.y = e.clientY;
    hold(null);
    offer(null);
    return;
  }
  aim(e.clientX, e.clientY);
}

function onUp(): void {
  const files = fileDrag.files;
  const away = fileDrag.outside || fileDrag.window !== null;
  stopListening();
  if (files === null) return clearDrag();
  // The release also produces a click on the row the drag started from.
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 0);
  if (!away) {
    tellLeft();
    return land();
  }
  // Let go of over another window, or outside every one: the page asks the
  // backend what is under the pointer now, and that window does the rest.
  told = false;
  const release = host?.release;
  clearDrag();
  afterTelling(() => release?.(files));
}

function onCancel(): void {
  cancelFileDrag();
}

/** `Esc` puts the files back: nothing is dropped. */
function cancelByKey(): void {
  cancelFileDrag();
  swallowReleaseClick((on) => (swallowClick = on));
}

/**
 * Arm a possible drag from a row's `pointerdown`; it starts once the pointer
 * moves. `pick` is asked then — what is carried may depend on what the press
 * made of the selection.
 */
export function beginFileDrag(e: PointerEvent, pick: () => CarriedFiles | null): void {
  if (e.button !== 0) return;
  cancelFileDrag();
  // A call that never came back must not hold up every drag after it.
  telling = null;
  tellAgain = false;
  holdSelection();
  candidate = {
    pick,
    startX: e.clientX,
    startY: e.clientY,
    el: e.currentTarget as HTMLElement,
    pointerId: e.pointerId,
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  stopEscape = cancelOnEscape(() => fileDrag.files !== null && !fileDrag.guest, cancelByKey);
}

/** True once for the click that ends a drag — the row's `onclick` returns early. */
export function consumeFileDragClick(): boolean {
  const was = swallowClick;
  swallowClick = false;
  return was;
}

/** Abort any drag in progress: nothing is dropped. */
export function cancelFileDrag(): void {
  const mine = candidate !== null;
  stopListening();
  if (mine) tellLeft();
  clearDrag();
}

// ── Files this page does not hold itself ────────────────────────────────────
// Another window of the app holds its files over this one, or the system drags
// files in from the desktop. This page has no pointer events for either: it is
// told where they are, draws them, and — when told they were let go of — does
// what the target under that point means.

/** Files are held over this window at a point (viewport px). */
export function showGuestFiles(files: CarriedFiles, x: number, y: number): void {
  // A drag of this page's own is the page's: nobody else's files are drawn over it.
  if (candidate !== null) return;
  fileDrag.files = files;
  fileDrag.guest = true;
  aim(x, y);
}

/** They were let go of here, at a point. */
export function dropGuestFiles(files: CarriedFiles, x: number, y: number): void {
  if (candidate !== null) return;
  showGuestFiles(files, x, y);
  land();
}

/** They left, or were let go of elsewhere. */
export function clearGuestFiles(): void {
  if (candidate === null && fileDrag.guest) clearDrag();
}
