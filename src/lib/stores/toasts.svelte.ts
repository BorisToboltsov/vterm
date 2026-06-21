// Toast notifications store (Svelte 5 runes): a small queue of non-blocking
// messages shown over the UI. Replaces inline error banners — any operation can
// surface a failure (or a status) without stealing focus or blocking the view.
// Pure bookkeeping + auto-dismiss timers; the visual is in Toast.svelte.

export type ToastKind = "error" | "success" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
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

/**
 * Push a toast and return its id. Auto-dismisses after `ttl` ms (per-kind
 * default when omitted; pass `0` to keep it until dismissed manually).
 */
export function notify(message: string, kind: ToastKind = "info", ttl?: number): string {
  const id = crypto.randomUUID();
  toastsState.list = [...toastsState.list, { id, kind, message }];
  const delay = ttl ?? TOAST_TTL[kind];
  if (delay > 0) {
    timers.set(
      id,
      setTimeout(() => dismissToast(id), delay),
    );
  }
  return id;
}

export const notifyError = (message: string, ttl?: number): string =>
  notify(message, "error", ttl);
export const notifySuccess = (message: string, ttl?: number): string =>
  notify(message, "success", ttl);
export const notifyInfo = (message: string, ttl?: number): string =>
  notify(message, "info", ttl);

/** Remove every toast and cancel all pending timers. */
export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  toastsState.list = [];
}
