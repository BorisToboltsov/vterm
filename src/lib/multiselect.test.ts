import { describe, expect, it } from "vitest";
import { clickSelect, emptySelection, type SelectionState } from "./multiselect";

const order = ["/a", "/b", "/c", "/d", "/e"];
const sel = (paths: string[], anchor: string | null = null): SelectionState => ({
  selected: new Set(paths),
  anchor,
});
const paths = (s: SelectionState) => [...s.selected].sort();

describe("clickSelect", () => {
  it("plain click selects a single row and sets the anchor", () => {
    const r = clickSelect(sel(["/a", "/b"]), "/c", { toggle: false, range: false }, order);
    expect(paths(r)).toEqual(["/c"]);
    expect(r.anchor).toBe("/c");
  });

  it("ctrl click adds a row to the selection", () => {
    const r = clickSelect(sel(["/a"], "/a"), "/c", { toggle: true, range: false }, order);
    expect(paths(r)).toEqual(["/a", "/c"]);
    expect(r.anchor).toBe("/c");
  });

  it("ctrl click removes an already-selected row", () => {
    const r = clickSelect(sel(["/a", "/c"], "/a"), "/c", { toggle: true, range: false }, order);
    expect(paths(r)).toEqual(["/a"]);
    expect(r.anchor).toBe("/c");
  });

  it("shift click selects the range from the anchor (downward)", () => {
    const r = clickSelect(sel(["/b"], "/b"), "/d", { toggle: false, range: true }, order);
    expect(paths(r)).toEqual(["/b", "/c", "/d"]);
    expect(r.anchor).toBe("/b");
  });

  it("shift click selects the range regardless of direction (upward)", () => {
    const r = clickSelect(sel(["/d"], "/d"), "/b", { toggle: false, range: true }, order);
    expect(paths(r)).toEqual(["/b", "/c", "/d"]);
    expect(r.anchor).toBe("/d");
  });

  it("shift click replaces a prior range, keeping the same anchor", () => {
    const first = clickSelect(sel(["/b"], "/b"), "/d", { toggle: false, range: true }, order);
    const second = clickSelect(first, "/c", { toggle: false, range: true }, order);
    expect(paths(second)).toEqual(["/b", "/c"]);
    expect(second.anchor).toBe("/b");
  });

  it("shift click with no anchor falls back to a plain single select", () => {
    const r = clickSelect(emptySelection(), "/c", { toggle: false, range: true }, order);
    expect(paths(r)).toEqual(["/c"]);
    expect(r.anchor).toBe("/c");
  });

  it("shift click with a stale anchor (not in the list) falls back to plain select", () => {
    const r = clickSelect(sel(["/x"], "/x"), "/c", { toggle: false, range: true }, order);
    expect(paths(r)).toEqual(["/c"]);
    expect(r.anchor).toBe("/c");
  });
});
