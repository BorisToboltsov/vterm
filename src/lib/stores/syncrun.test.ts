import { beforeEach, describe, expect, it } from "vitest";
import { applySyncProgress, clearSyncRun, syncRunState } from "./syncrun.svelte";
import type { SftpProgress } from "../api";

const ev = (id: string, transferred: number, total: number, done = false): SftpProgress => ({
  id,
  name: id,
  direction: "upload",
  transferred,
  total,
  done,
  isFolder: false,
});

describe("syncrun store", () => {
  beforeEach(clearSyncRun);

  it("ignores transfers that aren't part of a sync run", () => {
    // Panel uploads/downloads share the channel; they must not appear in the dialog.
    applySyncProgress(ev("srv-1a2b", 5, 10));
    expect(syncRunState.map).toEqual({});
  });

  it("records sync rows by id", () => {
    applySyncProgress(ev("sync:app/main.py", 5, 10));
    expect(syncRunState.map["sync:app/main.py"]).toEqual({
      transferred: 5,
      total: 10,
      done: false,
    });
  });

  it("keeps finished rows instead of expiring them", () => {
    // The shared transfers store drops a done transfer after DONE_LINGER_MS; here
    // the tick has to survive to the end of the run — it is the run's report.
    applySyncProgress(ev("sync:a", 10, 10, true));
    applySyncProgress(ev("sync:b", 3, 9));
    expect(syncRunState.map["sync:a"].done).toBe(true);
    expect(Object.keys(syncRunState.map)).toHaveLength(2);
  });

  it("clears between runs", () => {
    applySyncProgress(ev("sync:a", 10, 10, true));
    clearSyncRun();
    expect(syncRunState.map).toEqual({});
  });
});
