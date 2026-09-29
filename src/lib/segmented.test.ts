import { describe, expect, it } from "vitest";
import { segmentStep } from "./segmented";

describe("segmentStep", () => {
  it("arrows move and wrap in both directions", () => {
    expect(segmentStep("ArrowRight", 0, 2)).toBe(1);
    expect(segmentStep("ArrowRight", 1, 2)).toBe(0);
    expect(segmentStep("ArrowDown", 1, 3)).toBe(2);
    expect(segmentStep("ArrowLeft", 0, 3)).toBe(2);
    expect(segmentStep("ArrowUp", 2, 3)).toBe(1);
  });

  it("Home/End jump to the ends", () => {
    expect(segmentStep("Home", 2, 3)).toBe(0);
    expect(segmentStep("End", 0, 3)).toBe(2);
  });

  it("other keys and empty groups are not navigation", () => {
    expect(segmentStep("Enter", 0, 2)).toBeNull();
    expect(segmentStep("a", 0, 2)).toBeNull();
    expect(segmentStep("ArrowRight", 0, 0)).toBeNull();
  });
});
