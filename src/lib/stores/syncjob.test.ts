import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  localHashTree: vi.fn(),
  sftpHashTree: vi.fn(),
  sftpSyncApply: vi.fn(),
  sftpCancel: vi.fn(),
}));
vi.mock("../api", () => hoisted);

import {
  applyScanProgress,
  compare,
  otherRunHolds,
  peekSyncJob,
  removeSyncJob,
  resetSyncJobs,
  syncJob,
  syncRunOwner,
} from "./syncjob.svelte";

beforeEach(() => {
  vi.clearAllMocks();
  resetSyncJobs();
});

describe("sync job store", () => {
  it("peeks without creating, creates on demand", () => {
    expect(peekSyncJob("s")).toBeNull();
    syncJob("s").localPath = "/l";
    expect(peekSyncJob("s")?.localPath).toBe("/l");
  });

  it("closing the tab stops a compare in flight and forgets the job", async () => {
    hoisted.localHashTree.mockReturnValue(new Promise(() => {}));
    hoisted.sftpHashTree.mockReturnValue(new Promise(() => {}));
    const job = syncJob("s");
    job.localPath = "/l";
    job.remote = "/r";
    void compare("s");
    const localId = hoisted.localHashTree.mock.calls[0][2];
    removeSyncJob("s");
    expect(hoisted.sftpCancel).toHaveBeenCalledWith(localId);
    expect(peekSyncJob("s")).toBeNull();
  });

  it("closing the tab stops its run and releases the progress feed", () => {
    const job = syncJob("s");
    job.applying = true;
    job.runId = "run-1";
    syncRunOwner.sessionId = "s";
    expect(otherRunHolds("t")).toBe(true);
    removeSyncJob("s");
    expect(hoisted.sftpCancel).toHaveBeenCalledWith("run-1");
    expect(otherRunHolds("t")).toBe(false);
  });

  it("routes scan counts to the compare they belong to", () => {
    const a = syncJob("a");
    a.comparing = true;
    a.compareId = "cmp-a";
    const b = syncJob("b");
    b.comparing = true;
    b.compareId = "cmp-b";
    applyScanProgress({ id: "cmp-a:remote", files: 7 });
    applyScanProgress({ id: "cmp-x:local", files: 9 });
    expect(a.scan).toEqual({ local: 0, remote: 7 });
    expect(b.scan).toEqual({ local: 0, remote: 0 });
  });
});
