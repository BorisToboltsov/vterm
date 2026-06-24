import { describe, it, expect } from "vitest";
import { colorToSgr, compileRules, applyHighlight } from "./highlight";
import type { HighlightRule } from "./settings.svelte";

const ESC = "\u001b";
const rule = (over: Partial<HighlightRule>): HighlightRule => ({
  id: "x",
  name: "",
  pattern: "",
  color: "red",
  enabled: true,
  caseSensitive: false,
  ...over,
});

describe("colorToSgr", () => {
  it("maps named colours to ANSI foreground codes", () => {
    expect(colorToSgr("red")).toBe("31");
    expect(colorToSgr("blue")).toBe("34");
    expect(colorToSgr("white")).toBe("37");
  });
});

describe("compileRules", () => {
  it("skips disabled rules and empty patterns", () => {
    expect(compileRules([rule({ enabled: false, pattern: "x" })])).toHaveLength(0);
    expect(compileRules([rule({ pattern: "" })])).toHaveLength(0);
  });

  it("skips malformed regexes", () => {
    expect(compileRules([rule({ pattern: "(" })])).toHaveLength(0);
  });

  it("compiles case-insensitively by default and respects caseSensitive", () => {
    expect(compileRules([rule({ pattern: "a" })])[0].re.flags).toBe("gi");
    expect(compileRules([rule({ pattern: "a", caseSensitive: true })])[0].re.flags).toBe("g");
  });
});

describe("applyHighlight", () => {
  it("returns text unchanged with no rules", () => {
    expect(applyHighlight("hello", [])).toBe("hello");
  });

  it("wraps a single match in SGR colour + reset", () => {
    const out = applyHighlight("an ERROR here", compileRules([rule({ pattern: "ERROR" })]));
    expect(out).toBe(`an ${ESC}[31mERROR${ESC}[39m here`);
  });

  it("matches case-insensitively by default", () => {
    const out = applyHighlight("oops error", compileRules([rule({ pattern: "ERROR" })]));
    expect(out).toBe(`oops ${ESC}[31merror${ESC}[39m`);
  });

  it("applies multiple rules with their own colours", () => {
    const rules = compileRules([
      rule({ pattern: "ERROR", color: "red" }),
      rule({ pattern: "WARN", color: "yellow" }),
    ]);
    const out = applyHighlight("ERROR and WARN", rules);
    expect(out).toBe(`${ESC}[31mERROR${ESC}[39m and ${ESC}[33mWARN${ESC}[39m`);
  });

  it("does not double-wrap overlapping matches (earliest start wins)", () => {
    const rules = compileRules([
      rule({ pattern: "ab", color: "red" }),
      rule({ pattern: "bc", color: "blue" }),
    ]);
    // "abc": ab matches [0,2], bc matches [1,3] → only ab is emitted.
    expect(applyHighlight("abc", rules)).toBe(`${ESC}[31mab${ESC}[39mc`);
  });

  it("never matches inside an existing escape sequence", () => {
    // Rule matches the letter "m"; the only "m" is inside the colour escape.
    const out = applyHighlight(`${ESC}[31mhi`, compileRules([rule({ pattern: "m" })]));
    expect(out).toBe(`${ESC}[31mhi`);
  });

  it("highlights real text even when escape sequences are present", () => {
    const out = applyHighlight(`${ESC}[1mERROR`, compileRules([rule({ pattern: "ERROR" })]));
    expect(out).toBe(`${ESC}[1m${ESC}[31mERROR${ESC}[39m`);
  });

  it("does not hang or wrap on zero-length matches", () => {
    expect(applyHighlight("abc", compileRules([rule({ pattern: "x*" })]))).toBe("abc");
  });
});
