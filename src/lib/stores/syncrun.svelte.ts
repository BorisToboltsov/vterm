// Per-file progress of the running directory sync (Phase 39.8). The shared
// transfers store can't back the sync dialog's plan list: it drops a finished
// transfer after DONE_LINGER_MS, so the ticks would fade off the list a second and
// a half after they appeared. This store keeps every row of the current run until
// the next run starts.
//
// Fed from the one app-level `sftp://progress` subscription in +page.svelte, which
// hands every event to both stores; ids that aren't `sync:` prefixed are ignored
// here, so ordinary panel transfers never show up in the dialog.

import type { SftpProgress } from "../api";
import { progressWeight, type SyncProgressMap } from "../sync";

// `done`/`weight` are running totals kept alongside the map, so the dialog's
// header reads them in O(1). Summing the whole plan per event (and copying the
// whole map per event, as this store once did) was quadratic in the file count
// and froze the dialog on big runs. Rows read `map[id]` for their own id only.
export const syncRunState = $state<{ map: SyncProgressMap; done: number; weight: number }>({
  map: {},
  done: 0,
  weight: 0,
});

/** Fold one progress event into the run; non-sync transfers are ignored. */
export function applySyncProgress(p: SftpProgress): void {
  if (!p.id.startsWith("sync:")) return;
  const prev = syncRunState.map[p.id];
  const next = { transferred: p.transferred, total: p.total, done: p.done };
  syncRunState.weight += progressWeight(next) - (prev ? progressWeight(prev) : 0);
  syncRunState.done += (next.done ? 1 : 0) - (prev?.done ? 1 : 0);
  syncRunState.map[p.id] = next;
}

/** Drop everything (a new run starts from a clean list). */
export function clearSyncRun(): void {
  syncRunState.map = {};
  syncRunState.done = 0;
  syncRunState.weight = 0;
}
