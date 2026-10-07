import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  localHashTree: vi.fn(),
  sftpHashTree: vi.fn(),
  sftpSyncApply: vi.fn(),
  sftpCancel: vi.fn(),
}));
vi.mock("../api", () => hoisted);

import {
  adoptSyncJob,
  apply,
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

  it("a run refused because another window is syncing leaves the plan as it was", async () => {
    hoisted.sftpSyncApply.mockRejectedValue(
      "sync-busy: another synchronization is already running",
    );
    const job = syncJob("s");
    job.localPath = "/l";
    job.remote = "/r";
    job.plan = [{ op: "upload", path: "a.txt" }] as never;
    await apply("s");
    // Not a stopped run: nothing ran, the compared plan is still good.
    expect(job.phase).toBe("idle");
    expect(job.applying).toBe(false);
    expect(job.plan).toHaveLength(1);
  });

  it("any other failure of a run marks it stopped", async () => {
    hoisted.sftpSyncApply.mockRejectedValue("connection lost");
    const job = syncJob("s");
    job.plan = [{ op: "upload", path: "a.txt" }] as never;
    await apply("s");
    expect(job.phase).toBe("stopped");
    expect(job.applying).toBe(false);
  });

  it("a job taken over from another window keeps its form and plan, not its work", () => {
    const from = syncJob("src");
    from.localPath = "/l";
    from.remote = "/r";
    from.direction = "pull";
    from.excludeText = "*.log";
    from.plan = [{ op: "download", path: "b.txt" }] as never;
    from.comparing = true;
    from.applying = true;
    from.phase = "running";
    from.dialogOpen = true;
    adoptSyncJob("s", JSON.parse(JSON.stringify(from)));
    expect(peekSyncJob("s")).toMatchObject({
      localPath: "/l",
      remote: "/r",
      direction: "pull",
      excludeText: "*.log",
      comparing: false,
      applying: false,
      phase: "idle",
      dialogOpen: false,
    });
    expect(peekSyncJob("s")?.plan).toHaveLength(1);
    // A finished or stopped run's report stays what it was.
    adoptSyncJob("t", { ...JSON.parse(JSON.stringify(from)), phase: "stopped" });
    expect(peekSyncJob("t")?.phase).toBe("stopped");
  });
});
