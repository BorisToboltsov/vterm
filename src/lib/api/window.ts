// The app's windows (ADR 0017 and 0018, mirror of appwin.rs): moving a tab out
// into a window of its own or into another open one, closing a window, and what
// windows tell each other.
import { invoke } from "@tauri-apps/api/core";
import { emit, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { QuitRow } from "../quitsummary";

/**
 * Listen for an event addressed to THIS window (and for app-wide ones).
 *
 * The plain `listen()` hears every event, including those the backend sent to
 * another window — a menu command meant for the focused window would then open
 * Settings in all of them, and each window would list the other's transfers.
 * Everything a window is told individually is subscribed through this.
 *
 * `async` on purpose: with no Tauri runtime (the browser preview) there is no
 * current window to ask, and that must be a rejected subscription — like the
 * plain `listen` there — not an exception that aborts the caller's setup.
 */
export async function listenHere<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<T>(event, handler);
}

// ── Events between windows ────────────────────────────────────────────────────

/** A secondary window is asked to close: confirm, then `closeWindow()`. */
export const WINDOW_CLOSE_EVENT = "window://close";
/** The server list or the folders changed on disk — re-read them. */
export const CATALOG_EVENT = "window://catalog";
/** Another window changed the settings; the payload is its snapshot. */
export const SETTINGS_EVENT = "window://settings";
/** Another window deleted servers; their tabs here close too. */
export const SERVERS_DELETED_EVENT = "window://servers-deleted";
/** The windows that take tabs changed; the payload is the whole list. */
export const WINDOWS_EVENT = "window://windows";
/** This window is offered a tab: `takeHandoff()`, or `declineHandoff()`. */
export const HANDOFF_EVENT = "window://handoff";
/** A tab of another window is held over this one, was let go of here, or left. */
export const DRAG_EVENT = "window://drag";

export interface SettingsBroadcast {
  /** Label of the window that made the change (it ignores its own echo). */
  from: string;
  /** `JSON.stringify(settings)` of that window. */
  json: string;
}

/** Tell the other windows the settings changed. */
export function broadcastSettings(payload: SettingsBroadcast): Promise<void> {
  return emit(SETTINGS_EVENT, payload);
}

export interface ServersDeleted {
  from: string;
  ids: string[];
}

/** Tell the other windows these servers are gone (their tabs close with them). */
export function announceServersDeleted(payload: ServersDeleted): Promise<void> {
  return emit(SERVERS_DELETED_EVENT, payload);
}

// ── Closing a secondary window ────────────────────────────────────────────────

/** Close this (secondary) window; the backend ends its sessions with it. */
export function closeWindow(): Promise<void> {
  return invoke<void>("close_window");
}

/** What this window would lose if the app quit now — reported as it changes. */
export function reportWindowSummary(rows: QuitRow[]): Promise<void> {
  return invoke<void>("report_window_summary", { rows });
}

/** Rows reported by every other window (unvalidated — see `mergeQuitRows`). */
export function otherWindowsSummary(): Promise<unknown> {
  return invoke<unknown>("other_windows_summary");
}

// ── Which windows take tabs ───────────────────────────────────────────────────

/**
 * This window takes tabs, and this is what the others show of it: the title of
 * the tab in its focused pane and how many tabs it has. Called once the window
 * listens for an offer, and again when either changes; the list of all windows
 * comes back as `WINDOWS_EVENT`, to this window too.
 */
export function announceWindow(title: string, tabs: number): Promise<void> {
  return invoke<void>("announce_window", { title, tabs });
}

// ── A tab dragged over another window ─────────────────────────────────────────
// Pointer events end at a window's edge, and the window under the pointer hears
// nothing of a drag that began elsewhere. So the window giving the tab up tells
// the backend, which asks the OS what the pointer is over and tells that window
// — it draws the tab and parts its own to make room.

/**
 * How the floating label of a dragged tab looks (mirror of `dragghost::Look`):
 * what this page draws next to the pointer — measured, with its colours — for
 * the window that draws the tab over the desktop.
 */
export interface DragLook {
  title: string;
  bg: string;
  fg: string;
  accent: string;
  dot: string;
  /** Size of the label as this page draws it, CSS px. */
  w: number;
  h: number;
}

/** Where a dragged tab is, as the backend sees it (mirror of `appwin::DragAnswer`). */
export interface DragAnswer {
  /** The other window of the app it is over — that window draws it. */
  window: string | null;
  /** Over none of the app's windows: a floating label draws it. */
  floating: boolean;
}

/**
 * A tab of this window is being dragged. The backend asks the OS which window
 * of the app the pointer is over and brings it to the front: another window is
 * told, and draws the tab; over none of them a floating label does, looking as
 * `look` says. `tab` is what the other window needs to draw it.
 */
export function dragOver(tab: unknown, look: DragLook | null = null): Promise<DragAnswer> {
  return invoke<DragAnswer>("drag_over", { tab, look });
}

/**
 * The tab was let go of outside this window. Asked anew — the release is the
 * gesture. Resolves with the label of the window it was dropped on, which now
 * keeps the tab's place until the tab arrives (`detachCommit` with that target,
 * or `dragEnd()` if it will not); null — dropped on none of the app's windows.
 */
export function dragDrop(tab: unknown): Promise<string | null> {
  return invoke<string | null>("drag_drop", { tab });
}

/**
 * The drag is over without the tab having moved — it came back into this
 * window, was cancelled, or the handoff after a drop failed: the window that
 * drew the tab forgets it.
 */
export function dragEnd(): Promise<void> {
  return invoke<void>("drag_end");
}

// ── Moving a tab to another window ────────────────────────────────────────────

/** Where the tab goes, and where a new window opens for it. */
export interface DetachOpts {
  /** Label of an open window to move the tab into; absent — a new window. */
  target?: string;
  /** Screen position the tab was dropped at; absent for the menu command. */
  x?: number;
  y?: number;
  /** The theme's panel colour, so the window never flashes another one. */
  background?: string;
}

/**
 * Step 1: hold the session's output. Resolves with how many `term://out` events
 * were sent before the hold — the terminal waits for that many, then snapshots.
 */
export function detachBegin(sessionId: string): Promise<number> {
  return invoke<number>("detach_begin", { sessionId });
}

/** Roll step 1 back: the held output comes to this window after all. */
export function detachAbort(sessionId: string): Promise<void> {
  return invoke<void>("detach_abort", { sessionId });
}

/**
 * Step 2: leave the tab's packet for the window that takes it — a new one, or
 * the open window `opts.target` — and wait until it has taken the tab over.
 * Rejects — with everything rolled back — if it does not.
 */
export function detachCommit(sessionId: string, packet: string, opts: DetachOpts): Promise<string> {
  return invoke<string>("detach_commit", { sessionId, packet, opts });
}

/** In the window taking a tab: its packet (handed out once). */
export function takeHandoff(): Promise<string | null> {
  return invoke<string | null>("take_handoff");
}

/**
 * In a window that was offered a tab and cannot take it: say so now, so the
 * window giving it up is not left waiting for its timeout. `sessionId` names
 * the tab when this window got as far as knowing it.
 */
export function declineHandoff(sessionId: string | null = null): Promise<void> {
  return invoke<void>("decline_handoff", { sessionId });
}

/** In the window taking a tab: its terminal is restored and listening — take the session. */
export function attachSession(sessionId: string): Promise<void> {
  return invoke<void>("attach_session", { sessionId });
}
