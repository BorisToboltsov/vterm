import { describe, expect, it } from "vitest";
import { accumulatePinch, PINCH_STEP, TERM_FONT_MAX, TERM_FONT_MIN } from "./termzoom";

describe("accumulatePinch", () => {
  it("holds size steady until the accumulator crosses one step", () => {
    const r = accumulatePinch(13, 0, -(PINCH_STEP - 1));
    expect(r.size).toBe(13);
    expect(r.accum).toBe(-(PINCH_STEP - 1));
  });

  it("grows the font when deltaY is negative (fingers spreading / zoom in)", () => {
    const r = accumulatePinch(13, 0, -PINCH_STEP);
    expect(r.size).toBe(14);
    expect(r.accum).toBe(0);
  });

  it("shrinks the font when deltaY is positive (zoom out)", () => {
    const r = accumulatePinch(13, 0, PINCH_STEP);
    expect(r.size).toBe(12);
    expect(r.accum).toBe(0);
  });

  it("steps multiple sizes for a large delta and carries the remainder", () => {
    const r = accumulatePinch(13, 0, -(PINCH_STEP * 2 + 3));
    expect(r.size).toBe(15);
    expect(r.accum).toBe(-3);
  });

  it("accumulates fractional deltas across events", () => {
    let acc = 0;
    let size = 13;
    for (let i = 0; i < 4; i++) {
      const r = accumulatePinch(size, acc, -PINCH_STEP / 4);
      size = r.size;
      acc = r.accum;
    }
    expect(size).toBe(14);
  });

  it("clamps at the maximum and drains the accumulator there", () => {
    const r = accumulatePinch(TERM_FONT_MAX, 0, -PINCH_STEP * 3);
    expect(r.size).toBe(TERM_FONT_MAX);
    expect(r.accum).toBe(0);
  });

  it("clamps at the minimum and drains the accumulator there", () => {
    const r = accumulatePinch(TERM_FONT_MIN, 0, PINCH_STEP * 3);
    expect(r.size).toBe(TERM_FONT_MIN);
    expect(r.accum).toBe(0);
  });
});
