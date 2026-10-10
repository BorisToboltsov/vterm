import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferJob } from "../api";
import type { TransferRow } from "../transfer";
import { dirRevision, resetDockState } from "./dockstate.svelte";
import {
  aggregateTransfers,
  applyJob,
  applyProgress,
  clearTransfers,
  DONE_LINGER_MS,
  dropTransfersOf,
  removeTransfer,
  setTransferClock,
  transfersOf,
  transfersState,
} from "./transfers.svelte";

function p(over: Partial<TransferRow> & { id: string }): TransferRow {
  return {
    name: "f",
    direction: "upload",
    transferred: 0,
    total: 0,
    done: false,
    ...over,
  };
}

describe("aggregateTransfers", () => {
  it("is idle for an empty list", () => {
    expect(aggregateTransfers([])).toEqual({ active: 0, pct: 0, direction: null });
  });

  it("counts active transfers and the weighted percent", () => {
    const s = aggregateTransfers([
      p({ id: "1", transferred: 1, total: 4, direction: "download" }),
      p({ id: "2", transferred: 3, total: 4, direction: "download", done: true }),
    ]);
    expect(s.active).toBe(1);
    expect(s.pct).toBe(50); // (1+3)/(4+4)
    expect(s.direction).toBe("download");
  });

  it("only copies in the set: the arrow of a copy", () => {
    expect(aggregateTransfers([p({ id: "1", direction: "copy", total: 1 })]).direction).toBe("copy");
    expect(
      aggregateTransfers([
        p({ id: "1", direction: "copy", total: 1 }),
        p({ id: "2", direction: "download", total: 1 }),
      ]).direction,
    ).toBe("download");
  });

  it("an upload in the set wins the arrow", () => {
    const s = aggregateTransfers([
      p({ id: "1", direction: "download", total: 1 }),
      p({ id: "2", direction: "upload", total: 1 }),
    ]);
    expect(s.direction).toBe("upload");
  });
});

describe("transfers store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearTransfers();
  });
  afterEach(() => {
    clearTransfers();
    vi.useRealTimers();
  });

  it("applyProgress upserts by id", () => {
    applyProgress(p({ id: "a", transferred: 1, total: 10 }));
    applyProgress(p({ id: "a", transferred: 5, total: 10 }));
    expect(Object.values(transfersState.map)).toHaveLength(1);
    expect(transfersState.map.a.transferred).toBe(5);
  });

  it("auto-removes a finished transfer after the linger window", () => {
    applyProgress(p({ id: "b", done: true, transferred: 10, total: 10 }));
    expect(transfersState.map.b).toBeDefined();
    vi.advanceTimersByTime(DONE_LINGER_MS);
    expect(transfersState.map.b).toBeUndefined();
  });

  it("removeTransfer drops it immediately and cancels the timer", () => {
    applyProgress(p({ id: "c", done: true, total: 1, transferred: 1 }));
    removeTransfer("c");
    expect(transfersState.map.c).toBeUndefined();
    vi.advanceTimersByTime(DONE_LINGER_MS); // must not throw
    expect(transfersState.map.c).toBeUndefined();
  });
});

describe("rate tracking", () => {
  let clock = 0;

  beforeEach(() => {
    clock = 0;
    setTransferClock(() => clock);
    clearTransfers();
  });

  afterEach(() => setTransferClock(() => Date.now()));

  it("has no rate from a single snapshot", () => {
    applyProgress(p({ id: "a", transferred: 1000, total: 10_000 }));
    expect(transfersState.rates.a).toBeNull();
  });

  it("derives bytes per second from consecutive snapshots", () => {
    applyProgress(p({ id: "a", transferred: 0, total: 10_000 }));
    clock = 2000;
    applyProgress(p({ id: "a", transferred: 4000, total: 10_000 }));
    expect(transfersState.rates.a).toBeCloseTo(2000);
  });

  it("keeps per-transfer histories apart", () => {
    applyProgress(p({ id: "a", transferred: 0, total: 10_000 }));
    applyProgress(p({ id: "b", transferred: 0, total: 10_000 }));
    clock = 1000;
    applyProgress(p({ id: "a", transferred: 5000, total: 10_000 }));
    applyProgress(p({ id: "b", transferred: 500, total: 10_000 }));
    expect(transfersState.rates.a).toBeCloseTo(5000);
    expect(transfersState.rates.b).toBeCloseTo(500);
  });

  it("clears the rate when a transfer finishes (100% with a speed reads as still moving)", () => {
    applyProgress(p({ id: "a", transferred: 0, total: 10_000 }));
    clock = 1000;
    applyProgress(p({ id: "a", transferred: 5000, total: 10_000 }));
    expect(transfersState.rates.a).not.toBeNull();
    clock = 2000;
    applyProgress(p({ id: "a", transferred: 10_000, total: 10_000, done: true }));
    expect(transfersState.rates.a).toBeNull();
  });

  it("drops rate state with the transfer", () => {
    applyProgress(p({ id: "a", transferred: 0, total: 10_000 }));
    clock = 1000;
    applyProgress(p({ id: "a", transferred: 100, total: 10_000 }));
    removeTransfer("a");
    expect(transfersState.rates.a).toBeUndefined();
  });

  it("does not leak history between two transfers reusing an id", () => {
    applyProgress(p({ id: "a", transferred: 0, total: 10_000 }));
    clock = 1000;
    applyProgress(p({ id: "a", transferred: 9000, total: 10_000 }));
    removeTransfer("a");
    clock = 2000;
    applyProgress(p({ id: "a", transferred: 0, total: 10_000 }));
    expect(transfersState.rates.a).toBeNull();
  });
});

// A transfer is a job of the backend (v1.12, ADR 0025): the store only shows
// what the backend last said of the jobs of this window's sessions.
describe("jobs of the backend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearTransfers();
  });
  afterEach(() => {
    clearTransfers();
    vi.useRealTimers();
  });

  const side = (session: string | null, local = false) => ({ session, local, label: "" });
  function job(over: Partial<TransferJob> & { id: string }): TransferJob {
    return {
      src: side(null, true),
      dst: side("s1"),
      destDir: "/srv",
      name: "a.txt",
      fileIndex: 0,
      fileCount: 1,
      transferred: 0,
      total: 100,
      state: "running",
      error: null,
      failed: 0,
      skipped: 0,
      ...over,
    };
  }

  it("shows a job as a row of the sessions it touches", () => {
    resetDockState();
    applyJob(job({ id: "u", transferred: 40 }));
    applyJob(job({ id: "c", src: side("s1"), dst: side("s2"), fileCount: 3, fileIndex: 1 }));
    applyProgress(p({ id: "sync:a/b", direction: "download" }));

    expect(transfersState.map.u).toMatchObject({ direction: "upload", transferred: 40, done: false });
    expect(transfersState.map.c).toMatchObject({ direction: "copy", fileIndex: 1, fileCount: 3 });
    // A one-file job says nothing of "which file".
    expect(transfersState.map.u.fileCount).toBeUndefined();

    const ids = (session: string) => transfersOf(session).map((r) => r.id).sort();
    // A file of a sync run names no session: it is listed everywhere.
    expect(ids("s1")).toEqual(["c", "sync:a/b", "u"]);
    expect(ids("s2")).toEqual(["c", "sync:a/b"]);
    expect(ids("s3")).toEqual(["sync:a/b"]);
  });

  it("marks the folder changed once, when the job ends — however it ends", () => {
    resetDockState();
    applyJob(job({ id: "u", transferred: 10 }));
    applyJob(job({ id: "u", transferred: 90 }));
    expect(dirRevision("s1", "/srv")).toBe(0);
    applyJob(job({ id: "u", transferred: 100, state: "done" }));
    expect(dirRevision("s1", "/srv")).toBe(1);
    // Stopped or failed, some of its files may have landed all the same.
    applyJob(job({ id: "x", state: "cancelled" }));
    applyJob(job({ id: "y", state: "failed", failed: 1, error: "boom" }));
    expect(dirRevision("s1", "/srv")).toBe(3);
    // A download lands on the disk, outside any tab: no panel to re-list.
    applyJob(job({ id: "d", src: side("s1"), dst: side(null, true), destDir: "/Users/me", state: "done" }));
    expect(dirRevision("s1", "/Users/me")).toBe(0);
  });

  it("a job that has ended lingers a moment and goes", () => {
    resetDockState();
    applyJob(job({ id: "u", state: "done", transferred: 100 }));
    expect(transfersState.map.u.done).toBe(true);
    vi.advanceTimersByTime(DONE_LINGER_MS + 1);
    expect(transfersState.map.u).toBeUndefined();
  });

  it("a tab that leaves takes the rows that were only its own", () => {
    resetDockState();
    applyJob(job({ id: "own" }));
    applyJob(job({ id: "to-s2", src: side("s1"), dst: side("s2") }));
    applyJob(job({ id: "other", dst: side("s3") }));
    applyProgress(p({ id: "sync:x" }));
    // s1 leaves; s2 and s3 are still in this window.
    dropTransfersOf("s1", (s) => s === "s2" || s === "s3");
    expect(Object.keys(transfersState.map).sort()).toEqual(["other", "sync:x", "to-s2"]);
    // Then s2 leaves too: the copy between them has no tab left here.
    dropTransfersOf("s2", (s) => s === "s3");
    expect(Object.keys(transfersState.map).sort()).toEqual(["other", "sync:x"]);
  });
});
