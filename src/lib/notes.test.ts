import { describe, it, expect } from "vitest";
import { noteStats, notesDirty, hasNotes } from "./notes";

describe("noteStats", () => {
  it("counts chars, words and lines", () => {
    const s = noteStats("hello world\nsecond line");
    expect(s.chars).toBe("hello world\nsecond line".length);
    expect(s.words).toBe(4);
    expect(s.lines).toBe(2);
    expect(s.empty).toBe(false);
  });

  it("treats empty / whitespace-only as empty with zero words", () => {
    for (const t of ["", "   ", "\n\t "]) {
      const s = noteStats(t);
      expect(s.empty, t).toBe(true);
      expect(s.words, t).toBe(0);
    }
    // Empty string has zero lines; whitespace-only still has its line(s).
    expect(noteStats("").lines).toBe(0);
    expect(noteStats("   ").lines).toBe(1);
  });

  it("counts code points, not UTF-16 units (emoji = 1 char)", () => {
    expect(noteStats("🚀").chars).toBe(1);
  });
});

describe("notesDirty", () => {
  it("is true only when the buffer differs from what's saved", () => {
    expect(notesDirty("a", "a")).toBe(false);
    expect(notesDirty("a ", "a")).toBe(true);
    expect(notesDirty("", "")).toBe(false);
  });
});

describe("hasNotes", () => {
  it("is true only for non-blank notes", () => {
    expect(hasNotes("x")).toBe(true);
    expect(hasNotes("  \n ")).toBe(false);
    expect(hasNotes("")).toBe(false);
    expect(hasNotes(null)).toBe(false);
    expect(hasNotes(undefined)).toBe(false);
  });
});
