// The app's windows (ADR 0017, mirror of appwin.rs): moving a tab out into a
// window of its own, closing that window, and what windows tell each other.
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

// ── Moving a tab out to a new window ──────────────────────────────────────────

/** Where the new window opens. */
export interface DetachOpts {
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
 * Step 2: open the new window with the tab's packet and wait until it has taken
 * the tab over. Rejects — with everything rolled back — if it does not.
 */
export function detachCommit(sessionId: string, packet: string, opts: DetachOpts): Promise<string> {
  return invoke<string>("detach_commit", { sessionId, packet, opts });
}

/** In a new window: the packet of the tab moved into it (handed out once). */
export function takeHandoff(): Promise<string | null> {
  return invoke<string | null>("take_handoff");
}

/** In a new window: its terminal is restored and listening — take the session. */
export function attachSession(sessionId: string): Promise<void> {
  return invoke<void>("attach_session", { sessionId });
}
