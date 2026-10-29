import { describe, expect, it } from "vitest";
import {
  HISTORY_LEN,
  historyMax,
  padHistory,
  parsePercent,
  pushSamples,
  type LoadHistory,
} from "./loadhistory";

/** Snapshot helper: ids → readings. */
const snap = (o: Record<string, number>) => new Map(Object.entries(o));

describe("pushSamples", () => {
  it("starts a history for a newly seen object", () => {
    expect(pushSamples({}, ["a"], snap({ a: 12 }))).toEqual({ a: [12] });
  });

  it("appends to an existing history, oldest first", () => {
    const prev: LoadHistory = { a: [1, 2] };
    expect(pushSamples(prev, ["a"], snap({ a: 3 }))).toEqual({ a: [1, 2, 3] });
  });

  it("drops objects that are gone (a removed container must not leak)", () => {
    const prev: LoadHistory = { a: [1], b: [2] };
    expect(pushSamples(prev, ["a"], snap({ a: 5 }))).toEqual({ a: [1, 5] });
  });

  it("keeps the history of a live object with no reading this cycle", () => {
    const prev: LoadHistory = { a: [1, 2, 3] };
    expect(pushSamples(prev, ["a"], snap({}))).toEqual({ a: [1, 2, 3] });
  });

  it("does not push a zero for a missing reading — that would draw a dip that never happened", () => {
    const after = pushSamples({ a: [40, 41] }, ["a"], snap({}));
    expect(after.a).not.toContain(0);
    expect(after.a).toHaveLength(2);
  });

  it("keeps a live object with no reading and no history as an empty series", () => {
    expect(pushSamples({}, ["a"], snap({}))).toEqual({ a: [] });
  });

  it("caps the series at HISTORY_LEN, keeping the newest samples", () => {
    let h: LoadHistory = {};
    for (let i = 0; i < HISTORY_LEN + 10; i++) h = pushSamples(h, ["a"], snap({ a: i }));
    expect(h.a).toHaveLength(HISTORY_LEN);
    expect(h.a[HISTORY_LEN - 1]).toBe(HISTORY_LEN + 9);
    expect(h.a[0]).toBe(10);
  });

  it("does not mutate the previous history", () => {
    const prev: LoadHistory = { a: [1] };
    pushSamples(prev, ["a"], snap({ a: 2 }));
    expect(prev).toEqual({ a: [1] });
  });

  it("tracks objects independently", () => {
    let h = pushSamples({}, ["a", "b"], snap({ a: 1, b: 10 }));
    h = pushSamples(h, ["a", "b"], snap({ a: 2, b: 20 }));
    expect(h).toEqual({ a: [1, 2], b: [10, 20] });
  });
});

describe("historyMax", () => {
  it("never scales below the floor, so idle noise does not look like load", () => {
    expect(historyMax([1, 2, 3], 100)).toBe(100);
  });

  it("grows past the floor when the data does (a container over 100% CPU)", () => {
    expect(historyMax([50, 260], 100)).toBe(260);
  });

  it("handles an empty series", () => {
    expect(historyMax([], 100)).toBe(100);
  });
});

describe("padHistory", () => {
  it("left-pads a young series so bars fill from the right", () => {
    expect(padHistory([5, 6], 4)).toEqual([0, 0, 5, 6]);
  });

  it("trims an over-long series to the newest samples", () => {
    expect(padHistory([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  it("defaults to HISTORY_LEN", () => {
    expect(padHistory([1])).toHaveLength(HISTORY_LEN);
  });
});

describe("parsePercent", () => {
  it("reads docker's percent strings", () => {
    expect(parsePercent("12.34%")).toBeCloseTo(12.34);
    expect(parsePercent("0.00%")).toBe(0);
    expect(parsePercent(" 250.5 % ")).toBeCloseTo(250.5);
    expect(parsePercent("7")).toBe(7);
  });

  it("is null for the CLI's placeholders and junk", () => {
    expect(parsePercent("--")).toBeNull();
    expect(parsePercent("")).toBeNull();
    expect(parsePercent(undefined)).toBeNull();
    expect(parsePercent("n/a")).toBeNull();
    expect(parsePercent("-3%")).toBeNull();
  });
});
