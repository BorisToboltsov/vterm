import { describe, expect, it } from "vitest";
import { columnOffset } from "./editorplace";

describe("columnOffset", () => {
  it("puts column 1 at the line's start and column n n−1 characters in", () => {
    expect(columnOffset(20, 1)).toBe(0);
    expect(columnOffset(20, 5)).toBe(4);
    expect(columnOffset(20, 21)).toBe(20);
  });
  it("is the line's start without a column, or for one that is not a column", () => {
    for (const column of [undefined, null, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(columnOffset(20, column)).toBe(0);
    }
  });
  it("stops at the line's end when the file changed since the output named the place", () => {
    expect(columnOffset(3, 40)).toBe(3);
    expect(columnOffset(0, 5)).toBe(0);
  });
});
