import { describe, it, expect } from "vitest";
import {
  buildMatcher,
  findMatchRows,
  contextSnippet,
  matchCountLabel,
} from "./search";

describe("buildMatcher", () => {
  it("returns null for an empty query", () => {
    expect(buildMatcher("")).toBeNull();
  });

  it("matches case-insensitively by default", () => {
    const re = buildMatcher("error")!;
    expect(re.test("FATAL ERROR")).toBe(true);
  });

  it("honours caseSensitive", () => {
    const re = buildMatcher("error", { caseSensitive: true })!;
    expect(re.test("FATAL ERROR")).toBe(false);
    expect(re.test("an error here")).toBe(true);
  });

  it("escapes regex metacharacters in literal mode", () => {
    const re = buildMatcher("a.b", {})!;
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
  });

  it("treats the query as a regex when regex=true", () => {
    const re = buildMatcher("a.b", { regex: true })!;
    expect(re.test("axb")).toBe(true);
  });

  it("wraps in word boundaries for wholeWord", () => {
    const re = buildMatcher("err", { wholeWord: true })!;
    expect(re.test("err here")).toBe(true);
    expect(re.test("errors")).toBe(false);
  });

  it("returns null for a malformed regex", () => {
    expect(buildMatcher("(", { regex: true })).toBeNull();
  });
});

describe("findMatchRows", () => {
  const lines = ["alpha", "beta ERROR", "gamma", "another error", "delta"];

  it("returns indices of matching rows top-to-bottom", () => {
    expect(findMatchRows(lines, "error")).toEqual([1, 3]);
  });

  it("returns empty for no query", () => {
    expect(findMatchRows(lines, "")).toEqual([]);
  });

  it("returns empty when nothing matches", () => {
    expect(findMatchRows(lines, "zzz")).toEqual([]);
  });

  it("respects case sensitivity", () => {
    expect(findMatchRows(lines, "ERROR", { caseSensitive: true })).toEqual([1]);
  });
});

describe("contextSnippet", () => {
  const lines = ["l0", "l1", "l2", "l3", "l4", "l5", "l6"];

  it("includes the row plus radius on each side", () => {
    expect(contextSnippet(lines, 3, 1)).toBe("l2\nl3\nl4");
  });

  it("clamps at the start of the buffer", () => {
    expect(contextSnippet(lines, 0, 2)).toBe("l0\nl1\nl2");
  });

  it("clamps at the end of the buffer", () => {
    expect(contextSnippet(lines, 6, 2)).toBe("l4\nl5\nl6");
  });

  it("trims trailing blank lines", () => {
    expect(contextSnippet(["a", "match", "", ""], 1, 5)).toBe("a\nmatch");
  });

  it("returns empty for an out-of-range row", () => {
    expect(contextSnippet(lines, -1, 2)).toBe("");
    expect(contextSnippet(lines, 99, 2)).toBe("");
  });
});

describe("matchCountLabel", () => {
  it("is empty with no matches", () => {
    expect(matchCountLabel(0, 0)).toBe("");
    expect(matchCountLabel(-1, 0)).toBe("");
  });

  it("formats active/total one-based", () => {
    expect(matchCountLabel(0, 57)).toBe("1/57");
    expect(matchCountLabel(2, 57)).toBe("3/57");
  });

  it("shows count+ when the active index is untracked", () => {
    expect(matchCountLabel(-1, 1200)).toBe("1200+");
  });
});
