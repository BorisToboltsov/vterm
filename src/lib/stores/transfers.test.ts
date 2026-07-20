import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SftpProgress } from "../api";
import {
  aggregateTransfers,
  applyProgress,
  clearTransfers,
  DONE_LINGER_MS,
  removeTransfer,
  setTransferClock,
  transfersState,
} from "./transfers.svelte";

function p(over: Partial<SftpProgress> & { id: string }): SftpProgress {
  return {
    name: "f",
    direction: "upload",
    transferred: 0,
    total: 0,
    done: false,
    isFolder: false,
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
