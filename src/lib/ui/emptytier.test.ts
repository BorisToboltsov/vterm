import { describe, expect, it } from "vitest";
import { EMPTY_TIERS, pickTier, type EmptyTier } from "./emptytier";

describe("pickTier", () => {
  it("tries the tiers roomiest first", () => {
    expect(EMPTY_TIERS).toEqual(["full", "medal", "line", "title"]);
    const tried: EmptyTier[] = [];
    pickTier((tier) => {
      tried.push(tier);
      return false;
    });
    expect(tried).toEqual([...EMPTY_TIERS]);
  });

  it("takes the first tier that fits and tries no further", () => {
    const tried: EmptyTier[] = [];
    const tier = pickTier((t) => {
      tried.push(t);
      return t === "medal" || t === "line";
    });
    expect(tier).toBe("medal");
    expect(tried).toEqual(["full", "medal"]);
  });

  it("keeps the full layout when there is room for it", () => {
    expect(pickTier(() => true)).toBe("full");
  });

  it("falls back to the title alone when nothing fits", () => {
    expect(pickTier(() => false)).toBe("title");
  });
});
