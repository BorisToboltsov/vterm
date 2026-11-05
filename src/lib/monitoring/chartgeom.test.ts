import { describe, expect, it } from "vitest";
import {
  areaPath,
  bandPath,
  edgeDot,
  HISTORY,
  linePath,
  monotonePath,
  niceCeil,
  runs,
  slotX,
  stack,
  timeMarks,
  windowMax,
  yOf,
} from "./chartgeom";

const smp = (vals: (number | null)[], from = 0) => vals.map((v, i) => ({ s: from + i, v }));

describe("a chart's places", () => {
  it("puts the newest sample at the right edge and fills from the right — no squeeze while the window fills", () => {
    // Live violation of the old chart: 3 samples spread over the whole width.
    expect(slotX(2, 2, 100, 11)).toBe(100);
    expect(slotX(1, 2, 100, 11)).toBe(90);
    // A fourth sample does not move the others' spacing: each step is width/(slots−1).
    expect(slotX(1, 3, 100, 11) - slotX(0, 3, 100, 11)).toBe(10);
    expect(slotX(0, 0, 100)).toBe(100);
  });

  it("slides a sample in as the edge runs to it", () => {
    // Halfway from sample 4 to 5: the new sample is half a step past the edge.
    expect(slotX(5, 4.5, 100, 11)).toBe(105);
  });

  it("scales to a round, named ceiling and never below the floor", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(0.4)).toBe(1);
    expect(niceCeil(3.2)).toBe(5);
    expect(niceCeil(7.1e6)).toBe(1e7);
    expect(niceCeil(1.5e6)).toBe(2e6);
    expect(niceCeil(NaN, 4)).toBe(4);
  });

  it("clamps a value outside the scale to the chart", () => {
    expect(yOf(150, 100, 0, 50)).toBe(0);
    expect(yOf(-5, 100, 0, 50)).toBe(50);
    expect(yOf(50, 0, 0, 50)).toBe(50);
  });
});

describe("runs", () => {
  const f = { axis: 4, width: 40, top: 0, height: 10, max: 10, slots: 5 };

  it("breaks the line where a value was not read", () => {
    const r = runs(smp([1, 2, null, 4, 5]), f);
    expect(r.map((x) => x.length)).toEqual([2, 2]);
  });

  it("drops samples more than a slot past the left edge", () => {
    const r = runs(smp([1, 2, 3, 4, 5, 6, 7], -2), f);
    // s = −2 is two steps left of x=0 — gone; s = −1 still draws as it slides out.
    expect(r[0][0].x).toBe(-10);
  });

  it("draws the lower half of a mirrored chart downward", () => {
    const [[p]] = runs(smp([5], 4), { ...f, top: 10, down: true });
    expect(p.y).toBe(15);
  });
});

describe("paths", () => {
  it("never overshoots the samples it joins", () => {
    // A step 0 → 10 → 10: a plain cubic would bulge above 10 between the last two.
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 0 },
    ];
    const d = monotonePath(pts);
    const ys = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(10);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it("falls back to a polyline for two points, and closes areas and bands", () => {
    const two = [
      { x: 0, y: 1 },
      { x: 5, y: 2 },
    ];
    expect(monotonePath(two)).toBe(linePath(two));
    expect(areaPath(linePath(two), two, 10)).toBe("M0,1 L5,2 L5,10 L0,10 Z");
    expect(areaPath("M0,0", [{ x: 0, y: 0 }], 10)).toBe("");
    expect(bandPath(two, two.map((p) => ({ x: p.x, y: 9 })))).toBe("M0,1 L5,2 L5,9 L0,9 Z");
  });

  it("keeps the newest-point marker on the line at the edge while the point slides in", () => {
    const pts = [
      { x: 80, y: 10 },
      { x: 120, y: 30 },
    ];
    expect(edgeDot(pts, 100)).toEqual({ x: 100, y: 20 });
    expect(edgeDot([{ x: 50, y: 5 }], 100)).toEqual({ x: 50, y: 5 });
    expect(edgeDot([], 100)).toBeNull();
  });
});

describe("stacked layers", () => {
  it("sums each layer onto the ones below, and a gap below is a gap above", () => {
    const [a, b] = stack([smp([1, 2, null]), smp([10, 10, 10])]);
    expect(a.top.map((x) => x.v)).toEqual([1, 2, null]);
    expect(b.base.map((x) => x.v)).toEqual([1, 2, null]);
    expect(b.top.map((x) => x.v)).toEqual([11, 12, null]);
  });
});

describe("window and marks", () => {
  it("takes the scale from the window only", () => {
    expect(windowMax([smp([100, 1, 2])], HISTORY + 1, HISTORY)).toBe(2);
    expect(windowMax([smp([null])], 0)).toBe(0);
  });

  it("marks the span of the window in seconds ago", () => {
    expect(timeMarks(121, 5).map((m) => m.ago)).toEqual([600, 400, 200, 0]);
  });
});
