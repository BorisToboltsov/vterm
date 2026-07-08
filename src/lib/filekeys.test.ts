import { describe, expect, it } from "vitest";
import { nextCursor, scrollForCursor } from "./filekeys";

describe("nextCursor", () => {
  it("moves down and up within bounds", () => {
    expect(nextCursor("ArrowDown", 2, 10, 5)).toBe(3);
    expect(nextCursor("ArrowUp", 2, 10, 5)).toBe(1);
  });

  it("clamps at the ends", () => {
    expect(nextCursor("ArrowDown", 9, 10, 5)).toBe(9);
    expect(nextCursor("ArrowUp", 0, 10, 5)).toBe(0);
  });

  it("jumps to first/last with Home/End", () => {
    expect(nextCursor("Home", 5, 10, 5)).toBe(0);
    expect(nextCursor("End", 5, 10, 5)).toBe(9);
  });

  it("pages by a viewport, clamped", () => {
    expect(nextCursor("PageDown", 1, 10, 5)).toBe(6);
    expect(nextCursor("PageDown", 8, 10, 5)).toBe(9);
    expect(nextCursor("PageUp", 8, 10, 5)).toBe(3);
    expect(nextCursor("PageUp", 1, 10, 5)).toBe(0);
  });

  it("starts at an end when nothing is focused yet (-1)", () => {
    expect(nextCursor("ArrowDown", -1, 10, 5)).toBe(0);
    expect(nextCursor("ArrowUp", -1, 10, 5)).toBe(9);
    expect(nextCursor("PageDown", -1, 10, 5)).toBe(4);
  });

  it("returns null for non-navigation keys and an empty list", () => {
    expect(nextCursor("Enter", 2, 10, 5)).toBeNull();
    expect(nextCursor("a", 2, 10, 5)).toBeNull();
    expect(nextCursor("ArrowDown", 0, 0, 5)).toBeNull();
  });
});

describe("scrollForCursor", () => {
  const rowH = 28;
  const viewportH = 280; // 10 rows

  it("keeps the offset when the row is already visible", () => {
    // headerRows 1 (".."), cursor 3 → top 112, within [0, 280).
    expect(scrollForCursor(3, rowH, viewportH, 0, 1)).toBe(0);
  });

  it("scrolls up to reveal a row above the viewport", () => {
    // cursor 0 with header row → top = 28; if scrolled down to 200, bring to 28.
    expect(scrollForCursor(0, rowH, viewportH, 200, 1)).toBe(28);
  });

  it("scrolls down to reveal a row below the viewport", () => {
    // cursor 20, header 1 → top 588, bottom 616; offset so bottom == 616.
    expect(scrollForCursor(20, rowH, viewportH, 0, 1)).toBe(616 - viewportH);
  });
});
