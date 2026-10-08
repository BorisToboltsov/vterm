import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  clampShare,
  isPanelSplit,
  nudgedShare,
  PANEL_SPLITS,
  panelShare,
  PART_MIN,
  sanitizeShares,
  SHARE_MAX,
  SHARE_MIN,
  shareAt,
  shareRange,
  shareWidth,
} from "./panelsplit";

describe("shareRange", () => {
  it("keeps both parts at the minimum width", () => {
    expect(shareRange(1000)).toEqual({ min: 0.24, max: 0.76 });
    // Right at the width a panel becomes wide (48rem).
    expect(shareRange(768)).toEqual({ min: 0.3125, max: 0.6875 });
  });

  it("in a very wide row the fixed limits take over", () => {
    expect(shareRange(4000)).toEqual({ min: SHARE_MIN, max: SHARE_MAX });
  });

  it("a row too narrow for two minimal parts is halved", () => {
    expect(shareRange(2 * PART_MIN - 1)).toEqual({ min: 0.5, max: 0.5 });
    expect(shareRange(2 * PART_MIN)).toEqual({ min: 0.5, max: 0.5 });
  });

  it("a width that is not measured yet is bound by the fixed limits alone", () => {
    for (const width of [0, -5, Number.NaN]) {
      expect(shareRange(width)).toEqual({ min: SHARE_MIN, max: SHARE_MAX });
    }
  });
});

describe("clampShare", () => {
  it("leaves a share the row allows as it is", () => {
    expect(clampShare(0.4, 1000)).toBe(0.4);
  });

  it("brings one that is outside back to the nearest limit", () => {
    expect(clampShare(0.05, 1000)).toBe(0.24);
    expect(clampShare(0.99, 1000)).toBe(0.76);
    expect(clampShare(0.3, 400)).toBe(0.5);
  });

  it("what is not a number is halves", () => {
    expect(clampShare(Number.NaN, 1000)).toBe(0.5);
    expect(clampShare(Number.POSITIVE_INFINITY, 1000)).toBe(0.5);
  });
});

describe("shareAt and nudgedShare", () => {
  it("puts the border where the pointer is", () => {
    expect(shareAt(1000, 300)).toBe(0.3);
    expect(shareAt(1000, 650)).toBe(0.65);
  });

  it("stops at a part's minimum", () => {
    expect(shareAt(1000, 10) * 1000).toBe(PART_MIN);
    expect((1 - shareAt(1000, 990)) * 1000).toBeCloseTo(PART_MIN);
  });

  it("an arrow key moves it by pixels, from where it is drawn", () => {
    expect(nudgedShare(0.5, 1000, 24)).toBeCloseTo(0.524);
    expect(nudgedShare(0.5, 1000, -24)).toBeCloseTo(0.476);
    // A stored share the row no longer allows is nudged from the limit it is drawn at.
    expect(nudgedShare(0.1, 1000, 24)).toBeCloseTo(0.264);
  });

  it("whatever is asked, neither part goes under the minimum and the share stays in its limits", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2 * PART_MIN, max: 5000 }),
        fc.double({ min: -10000, max: 10000, noNaN: true }),
        (width, px) => {
          const share = shareAt(width, px);
          expect(share).toBeGreaterThanOrEqual(SHARE_MIN);
          expect(share).toBeLessThanOrEqual(SHARE_MAX);
          expect(share * width).toBeGreaterThanOrEqual(PART_MIN - 1e-6);
          expect((1 - share) * width).toBeGreaterThanOrEqual(PART_MIN - 1e-6);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("shareWidth", () => {
  it("is a percentage, without the noise of binary fractions", () => {
    expect(shareWidth(0.4)).toBe("40%");
    expect(shareWidth(0.55 + 1e-16)).toBe("55%");
    expect(shareWidth(0.3125)).toBe("31.25%");
    expect(shareWidth(1 / 3)).toBe("33.33%");
  });
});

describe("sanitizeShares", () => {
  it("keeps the panels it knows, inside the fixed limits", () => {
    expect(sanitizeShares({ git: 0.3, docker: 0.95, k8s: 0.01 })).toEqual({
      git: 0.3,
      docker: SHARE_MAX,
      k8s: SHARE_MIN,
    });
  });

  it("drops what it cannot use", () => {
    expect(sanitizeShares({ git: "0.3", files: 0.4, docker: Number.NaN, k8s: null })).toEqual({});
    for (const junk of [null, undefined, 5, "x", [0.4], true]) {
      expect(sanitizeShares(junk)).toEqual({});
    }
    // An inherited name is not a panel.
    expect(isPanelSplit("toString")).toBe(false);
    expect(sanitizeShares(JSON.parse('{"__proto__": 0.4, "constructor": 0.4}'))).toEqual({});
  });
});

describe("panelShare", () => {
  it("starts each panel at its own share", () => {
    expect(panelShare({}, "git", 1200)).toBe(PANEL_SPLITS.git);
    expect(panelShare({}, "docker", 1200)).toBe(0.5);
    expect(panelShare({}, "k8s", 1200)).toBe(0.5);
  });

  it("the user's share wins — as far as the row allows it", () => {
    expect(panelShare({ git: 0.6 }, "git", 1200)).toBe(0.6);
    // The dock was made narrower since: the border is drawn at the limit, the stored share stays.
    expect(panelShare({ git: 0.25 }, "git", 800)).toBe(0.3);
  });
});
