// What closing vterm would cut off, one row per kind (the quit confirmation).
// Pure so the counting rules are testable without a window: the dialog only
// renders the rows this returns.

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
