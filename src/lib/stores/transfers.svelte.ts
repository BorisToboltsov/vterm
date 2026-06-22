// Shared SFTP transfer state (Svelte 5 runes). The `sftp://progress` event is
// subscribed once at the app level (see +page.svelte) and funnelled through
// `applyProgress`; both the SFTP panel and the status-bar indicator read from
// here, so progress stays visible even when the SFTP panel is collapsed.

import type { SftpProgress } from "../api";

export const transfersState = $state<{ map: Record<string, SftpProgress> }>({ map: {} });

/** Active (not-yet-finished) transfers, plus those still in their linger window. */
export const transferList = (): SftpProgress[] => Object.values(transfersState.map);

// Pending "remove after done" timers, keyed by transfer id.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** How long a finished transfer lingers before it disappears (ms). */
export const DONE_LINGER_MS = 1500;

/** Record a progress update; finished transfers auto-clear after a short linger. */
export function applyProgress(p: SftpProgress): void {
  transfersState.map = { ...transfersState.map, [p.id]: p };
  const existing = timers.get(p.id);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(p.id);
  }
  if (p.done) {
    timers.set(
      p.id,
      setTimeout(() => removeTransfer(p.id), DONE_LINGER_MS),
    );
  }
}

/** Drop a transfer immediately (and cancel its linger timer). */
export function removeTransfer(id: string): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
  const { [id]: _drop, ...rest } = transfersState.map;
  transfersState.map = rest;
}

/** Clear everything (used by tests). */
export function clearTransfers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  transfersState.map = {};
}

export interface TransferSummary {
  /** Number of in-flight (not done) transfers. */
  active: number;
  /** Aggregate percent across all listed transfers (0–100). */
  pct: number;
  /** "upload" when any upload is active, else "download", else null when idle. */
  direction: "upload" | "download" | null;
}

/**
 * Summarise a list of transfers for the compact status-bar indicator. Percent is
 * the bytes/files weighted average; an upload in the set wins the arrow.
 */
export function aggregateTransfers(list: SftpProgress[]): TransferSummary {
  const active = list.filter((t) => !t.done).length;
  let transferred = 0;
  let total = 0;
  for (const t of list) {
    transferred += t.transferred;
    total += t.total;
  }
  const pct = total > 0 ? Math.round((transferred / total) * 100) : 0;
  const direction = list.length === 0
    ? null
    : list.some((t) => t.direction === "upload")
      ? "upload"
      : "download";
  return { active, pct, direction };
}
