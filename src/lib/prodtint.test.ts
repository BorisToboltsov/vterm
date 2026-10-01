import { describe, expect, it } from "vitest";
import { terminalBackground, sanitizeProdTint, DEFAULT_PROD_TINT } from "./prodtint";
import { mixHex } from "./colormix";

describe("prod tint", () => {
  it("mixes a percentage of the colour into the background", () => {
    expect(mixHex("#000000", "#ff0000", 10)).toBe("#1a0000");
    expect(mixHex("#ffffff", "#000000", 50)).toBe("#808080");
    expect(mixHex("#0a0e14", "#7a1f2b", 0)).toBe("#0a0e14");
    expect(mixHex("#abc", "#000", 100)).toBe("#000000");
  });
  it("leaves a background it can't parse alone", () => {
    expect(mixHex("rgba(0,0,0,0.5)", "#7a1f2b", 10)).toBe("rgba(0,0,0,0.5)");
    expect(mixHex("#000000", "red", 10)).toBe("#000000");
  });
  it("tints only when enabled", () => {
    expect(terminalBackground("#000000", null)).toBe("#000000");
    expect(terminalBackground("#000000", { ...DEFAULT_PROD_TINT, enabled: false })).toBe("#000000");
    expect(terminalBackground("#000000", { enabled: true, color: "#ff0000", strength: 10 })).toBe("#1a0000");
  });
  it("sanitizes a stored value", () => {
    expect(sanitizeProdTint(undefined)).toEqual(DEFAULT_PROD_TINT);
    expect(sanitizeProdTint({ enabled: false, color: "javascript:x", strength: 99 })).toEqual({
      enabled: false,
      color: DEFAULT_PROD_TINT.color,
      strength: 25,
    });
    expect(sanitizeProdTint({ color: "#112233", strength: 1.2 }).strength).toBe(3);
  });
});
