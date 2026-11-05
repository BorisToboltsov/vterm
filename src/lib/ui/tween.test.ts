import { describe, expect, it } from "vitest";
import { BAR_MS, easeOut, LINE_MS, MERGE_MS, progress, retarget, RING_MS, still, tweenAt } from "./tween";

describe("a value running to its reading", () => {
  it("eases from where it stood to the reading, and lands on it", () => {
    const tw = retarget(still(22), 78, 1000, 700);
    expect(tweenAt(tw, 1000, 700)).toBe(22);
    const mid = tweenAt(tw, 1350, 700) ?? 0;
    expect(mid).toBeGreaterThan(50); // fast first: past halfway at half the time
    expect(mid).toBeLessThan(78);
    expect(tweenAt(tw, 1700, 700)).toBe(78);
    expect(tweenAt(tw, 9000, 700)).toBe(78);
  });

  it("never runs back: a reading mid-way starts from where the value stands", () => {
    const first = retarget(still(10), 90, 0, 700);
    const at = tweenAt(first, 200, 700) ?? 0;
    const second = retarget(first, 40, 200, 700);
    expect(second.from).toBeCloseTo(at, 10);
    expect(tweenAt(second, 200, 700)).toBeCloseTo(at, 10);
    expect(tweenAt(second, 900, 700)).toBe(40);
  });

  it("keeps going when the reading has not changed", () => {
    const tw = retarget(still(10), 90, 0, 700);
    expect(retarget(tw, 90, 300, 700)).toBe(tw);
  });

  it("fills a ring from empty, but stands an axis at once", () => {
    const ring = retarget(still(null), 64, 0, 700);
    expect(tweenAt(ring, 0, 700)).toBe(0);
    expect(tweenAt(ring, 700, 700)).toBe(64);
    const axis = retarget(still(null), 5_000_000, 0, 800, null);
    expect(axis).toEqual(still(5_000_000));
  });

  it("stops showing an unknown value at once — a drop that was not read is not drawn", () => {
    const tw = retarget(still(70), null, 0, 700);
    expect(tweenAt(tw, 0, 700)).toBeNull();
    expect(retarget(still(70), NaN, 0, 700)).toEqual(still(null));
    expect(tweenAt(still(null), 0, 700)).toBeNull();
    // Nowhere to come from: the value stands where it is.
    expect(tweenAt({ from: null, to: 5, at: 0 }, 0, 700)).toBe(5);
  });

  it("is instant without a duration — reduced motion", () => {
    expect(retarget(still(22), 78, 0, 0)).toEqual(still(78));
    expect(retarget(still(null), 78, 0, 0)).toEqual(still(78));
    expect(tweenAt({ from: 22, to: 78, at: 0 }, 0, 0)).toBe(78);
    expect(progress(0, 0, 0)).toBe(1);
  });
});

describe("the curve and the pace", () => {
  it("runs 0 → 1 without overshoot, settling at the end", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(NaN)).toBe(1);
    let last = 0;
    for (let t = 0.05; t <= 1; t += 0.05) {
      const v = easeOut(t);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeLessThanOrEqual(1);
      last = v;
    }
    // Most of the way early, little left at the end.
    expect(easeOut(0.5)).toBeGreaterThan(0.8);
  });

  it("measures progress within the duration only", () => {
    expect(progress(100, 50, 200)).toBe(0);
    expect(progress(100, 200, 200)).toBe(0.5);
    expect(progress(100, 900, 200)).toBe(1);
    expect(progress(-Infinity, 0, 200)).toBe(1);
  });

  it("finishes every change before the next reading can come", () => {
    // The shortest poll the settings allow is 2 s: animations never pile up.
    for (const ms of [RING_MS, LINE_MS, BAR_MS, MERGE_MS]) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThan(2000);
    }
  });
});
