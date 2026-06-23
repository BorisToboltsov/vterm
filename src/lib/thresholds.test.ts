import { describe, expect, it } from "vitest";
import { levelTextClass, thresholdClass, thresholdLevel } from "./thresholds";

describe("thresholdLevel", () => {
  const t = { warn: 80, crit: 95 };

  it("returns ok below the warn bound", () => {
    expect(thresholdLevel(50, t)).toBe("ok");
    expect(thresholdLevel(79.9, t)).toBe("ok");
  });

  it("returns warn at/above warn but below crit", () => {
    expect(thresholdLevel(80, t)).toBe("warn"); // inclusive
    expect(thresholdLevel(94, t)).toBe("warn");
  });

  it("returns crit at/above the crit bound (crit wins over warn)", () => {
    expect(thresholdLevel(95, t)).toBe("crit");
    expect(thresholdLevel(100, t)).toBe("crit");
  });

  it("treats null/undefined value or threshold as ok", () => {
    expect(thresholdLevel(null, t)).toBe("ok");
    expect(thresholdLevel(undefined, t)).toBe("ok");
    expect(thresholdLevel(99, undefined)).toBe("ok");
  });

  it("honours individually disabled (null) bounds", () => {
    expect(thresholdLevel(99, { warn: null, crit: null })).toBe("ok");
    expect(thresholdLevel(99, { warn: 50, crit: null })).toBe("warn");
    expect(thresholdLevel(99, { warn: null, crit: 90 })).toBe("crit");
  });
});

describe("levelTextClass / thresholdClass", () => {
  it("maps levels to text colour classes", () => {
    expect(levelTextClass("ok")).toBe("");
    expect(levelTextClass("warn")).toBe("text-warn");
    expect(levelTextClass("crit")).toBe("text-danger");
  });

  it("thresholdClass classifies and returns the class in one call", () => {
    expect(thresholdClass(96, { warn: 80, crit: 95 })).toBe("text-danger");
    expect(thresholdClass(85, { warn: 80, crit: 95 })).toBe("text-warn");
    expect(thresholdClass(10, { warn: 80, crit: 95 })).toBe("");
    expect(thresholdClass(null, { warn: 80, crit: 95 })).toBe("");
  });
});
