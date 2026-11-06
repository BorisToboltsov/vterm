import { describe, expect, it } from "vitest";
import { keepPresent, pick, pickMode } from "./listselect";

const ORDER = ["a", "b", "c", "d", "e"];

describe("picking rows", () => {
  it("reads the keys of a click", () => {
    expect(pickMode({})).toBeNull();
    expect(pickMode({ metaKey: true })).toBe("toggle");
    expect(pickMode({ ctrlKey: true })).toBe("toggle");
    expect(pickMode({ shiftKey: true, metaKey: true })).toBe("range");
  });

  it("toggles one row", () => {
    expect([...pick(new Set(), ORDER, null, "b", "toggle")]).toEqual(["b"]);
    expect([...pick(new Set(["b"]), ORDER, "b", "b", "toggle")]).toEqual([]);
  });

  it("takes the run between the anchor and the row, either way, keeping what was picked", () => {
    expect([...pick(new Set(["a"]), ORDER, "b", "d", "range")].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...pick(new Set(), ORDER, "d", "b", "range")].sort()).toEqual(["b", "c", "d"]);
  });

  it("is a toggle when there is no anchor shown", () => {
    expect([...pick(new Set(), ORDER, null, "c", "range")]).toEqual(["c"]);
    expect([...pick(new Set(), ORDER, "gone", "c", "range")]).toEqual(["c"]);
  });

  it("forgets rows that are gone, and keeps the same set when none went", () => {
    const s = new Set(["a", "x"]);
    expect([...keepPresent(s, ORDER)]).toEqual(["a"]);
    const same = new Set(["a", "b"]);
    expect(keepPresent(same, ORDER)).toBe(same);
  });
});
