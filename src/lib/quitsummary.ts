// What closing vterm would cut off, one row per kind (the quit confirmation).
// Pure so the counting rules are testable without a window: the dialog only
// renders the rows this returns.
//
// Since v1.3 a tab can live in a window of its own (ADR 0017). Closing such a
// window asks with that window's rows; quitting asks in the main window with
// everyone's — the other windows report theirs to the backend (`mergeQuitRows`).

import { isLive } from "./stores/tabs.svelte";
import { isCancellableTransfer } from "./transfer";

export type QuitRowKey = "ssh" | "local" | "transfers" | "sync" | "recording";

export interface QuitRow {
  key: QuitRowKey;
  count: number;
}

export interface QuitInput {
  tabs: readonly { kind: "ssh" | "local"; status: string }[];
  transfers: readonly { id: string; done: boolean }[];
  /** Sessions whose sync job is comparing or applying. */
  syncBusy: number;
  /** Sessions being recorded. */
  recordings: number;
}

/**
 * Rows for the quit dialog, in a fixed order, only the kinds that are non-zero.
 * A tab counts while it is live (connected or still connecting — quitting cuts
 * that connect off too); a dead tab loses nothing. Transfers count the way the
 * status bar's "cancel all" does: in flight and started by the user — a sync
 * run's files are the sync row.
 */
export function quitRows(input: QuitInput): QuitRow[] {
  const live = input.tabs.filter((t) => isLive(t.status));
  const rows: QuitRow[] = [
    { key: "ssh", count: live.filter((t) => t.kind === "ssh").length },
    { key: "local", count: live.filter((t) => t.kind === "local").length },
    { key: "transfers", count: input.transfers.filter(isCancellableTransfer).length },
    { key: "sync", count: input.syncBusy },
    { key: "recording", count: input.recordings },
  ];
  return rows.filter((r) => r.count > 0);
}

const ROW_ORDER: readonly QuitRowKey[] = ["ssh", "local", "transfers", "sync", "recording"];

/**
 * This window's rows plus the rows other windows reported, summed per kind and
 * back in the fixed order. `others` comes over IPC from another window's page,
 * so it is read defensively: an unknown kind or a count that is not a positive
 * whole number is skipped rather than shown.
 */
export function mergeQuitRows(own: readonly QuitRow[], others: unknown): QuitRow[] {
  const total = new Map<QuitRowKey, number>();
  const add = (key: unknown, count: unknown): void => {
    if (typeof key !== "string" || !ROW_ORDER.includes(key as QuitRowKey)) return;
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return;
    total.set(key as QuitRowKey, (total.get(key as QuitRowKey) ?? 0) + count);
  };
  for (const row of own) add(row.key, row.count);
  if (Array.isArray(others)) {
    for (const row of others) {
      if (row && typeof row === "object") {
        add((row as { key?: unknown }).key, (row as { count?: unknown }).count);
      }
    }
  }
  return ROW_ORDER.flatMap((key) => (total.has(key) ? [{ key, count: total.get(key)! }] : []));
}
