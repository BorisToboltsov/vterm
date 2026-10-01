import { describe, expect, it } from "vitest";
import { contrastRatio, isHexColor, mixHex, readableOn } from "./colormix";
import { THEMES } from "./themes";

describe("colormix", () => {
  it("mixes and passes non-hex through", () => {
    expect(mixHex("#000000", "#ff0000", 10)).toBe("#1a0000");
    expect(mixHex("#abc", "#000", 100)).toBe("#000000");
    expect(mixHex("rgba(0,0,0,.5)", "#fff", 50)).toBe("rgba(0,0,0,.5)");
    expect(isHexColor("#12345")).toBe(false);
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(contrastRatio("red", "#fff")).toBeNull();
  });

  it("lifts a dim colour just enough, keeps one that already reads", () => {
    const lifted = readableOn("#3b4252", "#2e3440", "#d8dee9");
    expect(contrastRatio(lifted, "#2e3440")!).toBeGreaterThanOrEqual(4.5);
    expect(lifted).not.toBe("#d8dee9"); // still dimmer than the text
    expect(readableOn("#aaaaaa", "#000000", "#ffffff")).toBe("#aaaaaa");
    expect(readableOn("oops", "#000", "#fff")).toBe("oops");
  });

  it("every built-in theme gets editor comments at AA contrast", () => {
    for (const th of THEMES) {
      const { brightBlack, background, foreground } = th.terminal;
      const c = readableOn(brightBlack, background, foreground);
      const ratio = contrastRatio(c, background);
      const best = contrastRatio(foreground, background);
      if (ratio === null || best === null) continue;
      // AA, or the text colour itself when even that can't reach it.
      expect(ratio, th.id).toBeGreaterThanOrEqual(Math.min(4.5, best) - 1e-9);
    }
  });
});
