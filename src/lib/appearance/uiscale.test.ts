import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_SCALE,
  rootFontSize,
  sanitizeUiScale,
  scaledPx,
  steppedUiScale,
  terminalFontPx,
  UI_SCALE_STOPS,
} from "./uiscale";

describe("sanitizeUiScale", () => {
  it("keeps a stop", () => {
    for (const stop of UI_SCALE_STOPS) expect(sanitizeUiScale(stop)).toBe(stop);
  });

  it("turns anything else into the default", () => {
    for (const raw of [undefined, null, "125", 124, 0, -100, 1e9, NaN, {}, []]) {
      expect(sanitizeUiScale(raw)).toBe(DEFAULT_UI_SCALE);
    }
  });
});

describe("scaledPx", () => {
  it("leaves 100 % alone", () => {
    expect(scaledPx(28, 100)).toBe(28);
  });

  it("keeps the fraction a row really has", () => {
    expect(scaledPx(28, 110)).toBeCloseTo(30.8);
    expect(scaledPx(28, 150)).toBe(42);
  });
});

describe("rootFontSize", () => {
  it("is a percentage of the default the rem is measured from", () => {
    expect(rootFontSize(125)).toBe("125%");
  });
});

describe("terminalFontPx", () => {
  it("multiplies the base and rounds to a whole px", () => {
    expect(terminalFontPx(13, 100)).toBe(13);
    expect(terminalFontPx(13, 125)).toBe(16);
    expect(terminalFontPx(13, 150)).toBe(20);
    expect(terminalFontPx(13, 90)).toBe(12);
  });
});

describe("steppedUiScale", () => {
  it("walks the stops", () => {
    expect(steppedUiScale(100, 1)).toBe(110);
    expect(steppedUiScale(110, 1)).toBe(125);
    expect(steppedUiScale(100, -1)).toBe(90);
  });

  it("stops at the ends", () => {
    expect(steppedUiScale(150, 1)).toBe(150);
    expect(steppedUiScale(90, -1)).toBe(90);
  });

  it("goes back to the default from anywhere", () => {
    expect(steppedUiScale(150, 0)).toBe(DEFAULT_UI_SCALE);
  });

  it("starts from the default when what it holds is not a stop", () => {
    expect(steppedUiScale(123, 1)).toBe(110);
  });
});
