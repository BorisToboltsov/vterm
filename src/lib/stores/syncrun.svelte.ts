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
import type { SyncProgressMap } from "../sync";

export const syncRunState = $state<{ map: SyncProgressMap }>({ map: {} });

/** Fold one progress event into the run; non-sync transfers are ignored. */
export function applySyncProgress(p: SftpProgress): void {
  if (!p.id.startsWith("sync:")) return;
  syncRunState.map = {
    ...syncRunState.map,
    [p.id]: { transferred: p.transferred, total: p.total, done: p.done },
  };
}

/** Drop everything (a new run starts from a clean list). */
export function clearSyncRun(): void {
  syncRunState.map = {};
}
