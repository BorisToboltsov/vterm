import { describe, expect, it } from "vitest";
import { isDark, editorTheme } from "./cmtheme";
import { getTheme, DEFAULT_THEME_ID } from "./themes";

describe("isDark", () => {
  it("classifies backgrounds by perceived luminance", () => {
    expect(isDark("#1e1e2e")).toBe(true); // Catppuccin Mocha bg
    expect(isDark("#000000")).toBe(true);
    expect(isDark("#ffffff")).toBe(false);
    expect(isDark("#eff1f5")).toBe(false); // Latte bg
  });

  it("treats malformed/short hex as dark (safe default → light text)", () => {
    expect(isDark("#abc")).toBe(true);
    expect(isDark("")).toBe(true);
  });
});

describe("editorTheme", () => {
  it("returns a non-empty extension set for a real theme palette", () => {
    const ext = editorTheme(getTheme(DEFAULT_THEME_ID).terminal);
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBeGreaterThan(0);
  });
});
