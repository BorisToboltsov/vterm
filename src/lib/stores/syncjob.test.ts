import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  localHashTree: vi.fn(),
  sftpHashTree: vi.fn(),
  sftpSyncStart: vi.fn(),
  syncRunOf: vi.fn(async (): Promise<unknown> => null),
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
  runHeard,
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
    hoisted.sftpSyncStart.mockRejectedValue(
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
    hoisted.sftpSyncStart.mockRejectedValue("connection lost");
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

describe("a run is the backend's (v1.36)", () => {
  const planned = (sid: string) => {
    const job = syncJob(sid);
    job.localPath = "/l";
    job.remote = "/r";
    job.plan = [
      { op: "upload", path: "a.txt" },
      { op: "upload", path: "b.txt" },
    ] as never;
    return job;
  };
  const view = (sid: string, runId: string, state: "running" | "done" | "stopped" | "failed", up = 0) => ({
    runId,
    sessionId: sid,
    state,
    stats: { uploaded: up, downloaded: 0, deleted: 0, stopped: state === "stopped" },
    error: state === "failed" ? "disk full" : null,
  });

  it("is started and left running: its end is heard, not awaited", async () => {
    hoisted.sftpSyncStart.mockResolvedValue(undefined);
    const job = planned("s");
    await apply("s");
    expect(job.applying).toBe(true);
    expect(job.runTotal).toBe(2);
    const runId = hoisted.sftpSyncStart.mock.calls[0][1];
    // Another run's word is not this one's.
    runHeard(view("s", "other-run", "done", 2));
    expect(job.applying).toBe(true);
    runHeard(view("s", runId, "done", 2));
    expect(job).toMatchObject({ applying: false, phase: "done", plan: null });
    // Heard again (the answer to `syncRunOf` after a move): nothing happens twice.
    job.plan = [{ op: "upload", path: "c.txt" }] as never;
    runHeard(view("s", runId, "done", 2));
    expect(job.plan).toHaveLength(1);
  });

  it("a stopped run keeps its plan as the report; a failed one says why", async () => {
    hoisted.sftpSyncStart.mockResolvedValue(undefined);
    const job = planned("s");
    await apply("s");
    runHeard(view("s", hoisted.sftpSyncStart.mock.calls[0][1], "stopped", 1));
    expect(job).toMatchObject({ applying: false, phase: "stopped" });
    expect(job.plan).toHaveLength(2);
    const other = planned("t");
    await apply("t");
    runHeard(view("t", hoisted.sftpSyncStart.mock.calls[1][1], "failed"));
    expect(other).toMatchObject({ applying: false, phase: "stopped" });
  });

  it("a tab handed to another window leaves its run going; a closed one stops it", () => {
    const job = syncJob("s");
    job.applying = true;
    job.runId = "run-1";
    removeSyncJob("s", true);
    expect(hoisted.sftpCancel).not.toHaveBeenCalled();
    expect(peekSyncJob("s")).toBeNull();
  });

  it("taken over mid-run, it goes on running here and asks how the run stands", async () => {
    let ask!: (v: unknown) => void;
    hoisted.syncRunOf.mockReturnValue(new Promise((r) => (ask = r)));
    const from = planned("x");
    from.applying = true;
    from.runId = "run-9";
    from.runTotal = 2;
    from.phase = "running";
    from.comparing = true;
    adoptSyncJob("s", JSON.parse(JSON.stringify(from)));
    expect(peekSyncJob("s")).toMatchObject({ applying: true, runId: "run-9", phase: "running", comparing: false });
    expect(syncRunOwner.sessionId).toBe("s");
    expect(hoisted.syncRunOf).toHaveBeenCalledWith("s");
    // It ended while the tab was on its way: its last word went to the window it left.
    ask(view("s", "run-9", "done", 2));
    await new Promise((r) => setTimeout(r, 0));
    expect(peekSyncJob("s")).toMatchObject({ applying: false, phase: "done" });
  });
});
