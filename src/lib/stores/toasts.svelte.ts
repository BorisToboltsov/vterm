// Toast notifications store (Svelte 5 runes): a small queue of non-blocking
// messages shown over the UI. Replaces inline error banners — any operation can
// surface a failure (or a status) without stealing focus or blocking the view.
//
// Every message is a note in the journal first (ADR 0062): the journal
// is one for all the windows and outlives the toast, so what flew by can be
// read later — masked on the way, for it is kept on disk. A toast is how this
// window shows it now: the same message said again counts up on its toast
// instead of standing a second one under it. What is told nobody — a poll that
// failed again, a reconnect attempt — is not a message but an event of the
// diagnostics (ADR 0063, `api/diag.ts`).
// Bookkeeping + auto-dismiss timers; the visual is in Toast.svelte.

import { redactSecrets } from "../ai/redact";
import { serverOf, toastKey, type JournalSource } from "../notifications/journal";
import { findTab } from "./tabs.svelte";
import { noteJournal } from "./journal.svelte";

export type ToastKind = "error" | "success" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** How many times it was said while it stood. */
  count: number;
  source?: JournalSource;
  /** The server it is about, by name. */
  server?: string;
  /** What makes it the same toast (`toastKey`). */
  key: string;
}

/** What a message says besides its words. */
export interface NotifyOptions {
  /** Auto-dismiss delay, ms: the kind's default when omitted, `0` — until dismissed. */
  ttl?: number;
  /** The part of the app that says it. */
  source?: JournalSource;
  /** The session it is about: its server is named in the toast and the journal. */
  sessionId?: string | null;
}

/** Default auto-dismiss delay (ms) per kind; errors linger a bit longer. */
export const TOAST_TTL: Record<ToastKind, number> = {
  error: 6000,
  success: 3000,
  info: 4000,
};

export const toastsState = $state<{ list: Toast[] }>({ list: [] });

// Pending auto-dismiss timers, keyed by toast id (kept out of the reactive state).
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Remove a toast and clear its pending auto-dismiss timer (if any). */
export function dismissToast(id: string): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
  toastsState.list = toastsState.list.filter((x) => x.id !== id);
}

function arm(id: string, delay: number): void {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
  if (delay > 0) timers.set(id, setTimeout(() => dismissToast(id), delay));
}

/**
 * Note a message in the journal and show it as a toast; returns the toast's id.
 * The same message said again while its toast stands
 * counts up on it and keeps it up for another full delay.
 */
export function notify(message: string, kind: ToastKind = "info", opts: NotifyOptions = {}): string {
  const { serverId, server } = serverOf(opts.sessionId ? findTab(opts.sessionId) : null);
  noteJournal({ kind, text: redactSecrets(message).text, source: opts.source, serverId, server });
  const key = toastKey(kind, message, opts.source, serverId);
  const delay = opts.ttl ?? TOAST_TTL[kind];
  const standing = toastsState.list.find((x) => x.key === key);
  if (standing) {
    // Said again: one toast, counted, and the newest again.
    toastsState.list = [
      ...toastsState.list.filter((x) => x.id !== standing.id),
      { ...standing, count: standing.count + 1 },
    ];
    arm(standing.id, delay);
    return standing.id;
  }
  const id = crypto.randomUUID();
  toastsState.list = [...toastsState.list, { id, kind, message, count: 1, source: opts.source, server, key }];
  arm(id, delay);
  return id;
}

export const notifyError = (message: string, opts?: NotifyOptions): string =>
  notify(message, "error", opts);
export const notifySuccess = (message: string, opts?: NotifyOptions): string =>
  notify(message, "success", opts);
export const notifyInfo = (message: string, opts?: NotifyOptions): string =>
  notify(message, "info", opts);

/** Remove every toast and cancel all pending timers. */
export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  toastsState.list = [];
}
