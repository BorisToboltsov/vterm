import { describe, it, expect } from "vitest";
import { windowRange } from "./virtuallist";

describe("windowRange", () => {
  const rowH = 28;

  it("renders a window around the top with overscan and correct total height", () => {
    // Viewport shows ~11 rows (300/28); at the top, start clamps to 0.
    const w = windowRange(0, 300, rowH, 10000, 6);
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
    expect(w.totalHeight).toBe(10000 * rowH);
    // 11 visible + 6 overscan below.
    expect(w.end).toBe(Math.ceil(300 / rowH) + 6);
  });

  it("slides the window with scroll and pads the top by start*rowH", () => {
    const w = windowRange(28 * 100, 300, rowH, 10000, 6);
    // first = floor(2800/28) = 100; start = 100 - 6 = 94.
    expect(w.start).toBe(94);
    expect(w.padTop).toBe(94 * rowH);
    expect(w.end).toBe(100 + Math.ceil(300 / rowH) + 6);
    // The rendered window stays tiny regardless of the 10k total.
    expect(w.end - w.start).toBeLessThan(40);
  });

  it("clamps the end to the item count near the bottom", () => {
    const count = 50;
    const w = windowRange(count * rowH, 300, rowH, count, 6);
    expect(w.end).toBe(count);
    expect(w.start).toBeLessThan(count);
  });

  it("never returns a negative start on overscroll bounce", () => {
    const w = windowRange(-200, 300, rowH, 100, 6);
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });

  it("handles an empty list", () => {
    const w = windowRange(0, 300, rowH, 0);
    expect(w).toEqual({ start: 0, end: 0, padTop: 0, totalHeight: 0 });
  });

  it("degrades to the full range when sizes are unknown (rowH/viewport 0)", () => {
    expect(windowRange(0, 0, 28, 5)).toMatchObject({ start: 0, end: 5 });
    expect(windowRange(0, 300, 0, 5)).toMatchObject({ start: 0, end: 5 });
  });

  it("clamps scrollTop past the end without overrunning the count", () => {
    const count = 100;
    const w = windowRange(999999, 300, rowH, count, 6);
    expect(w.end).toBe(count);
    expect(w.start).toBeGreaterThanOrEqual(0);
    expect(w.start).toBeLessThanOrEqual(count);
  });
});
