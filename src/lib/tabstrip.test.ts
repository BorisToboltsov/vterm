import { describe, expect, it } from "vitest";
import { activeTabStrip } from "./tabstrip";

describe("activeTabStrip", () => {
  it("is the theme accent, or red for a prod session", () => {
    expect(activeTabStrip(false, 2)).toBe("shadow-[inset_0_2px_0_0_var(--color-accent)]");
    expect(activeTabStrip(true, 2)).toBe("shadow-[inset_0_2px_0_0_var(--color-bad)]");
  });
  it("is thinner on editor sub-tabs", () => {
    expect(activeTabStrip(false, 1)).toBe("shadow-[inset_0_1px_0_0_var(--color-accent)]");
    expect(activeTabStrip(true, 1)).toBe("shadow-[inset_0_1px_0_0_var(--color-bad)]");
  });
});
