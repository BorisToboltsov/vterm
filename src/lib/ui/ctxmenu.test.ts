import { describe, expect, it } from "vitest";
import { clampMenuPosition, isAction, menuActions, menuPathOpen, toggleMenuPath, type MenuItem } from "./ctxmenu";

describe("clampMenuPosition", () => {
  const vw = 1000;
  const vh = 800;
  const w = 200;
  const h = 300;

  it("keeps the requested point when the menu fits", () => {
    expect(clampMenuPosition(100, 100, w, h, vw, vh)).toEqual({ x: 100, y: 100 });
  });

  it("shifts left when the menu would spill off the right edge", () => {
    // 900 + 200 = 1100 > 1000 → x = 1000 - 200 - 4 = 796
    expect(clampMenuPosition(900, 100, w, h, vw, vh).x).toBe(796);
  });

  it("shifts up when the menu would spill off the bottom edge", () => {
    // 700 + 300 = 1000 > 800 → y = 800 - 300 - 4 = 496
    expect(clampMenuPosition(100, 700, w, h, vw, vh).y).toBe(496);
  });

  it("never goes past the top-left margin", () => {
    expect(clampMenuPosition(-50, -50, w, h, vw, vh)).toEqual({ x: 4, y: 4 });
  });

  it("respects a custom margin", () => {
    expect(clampMenuPosition(-50, -50, w, h, vw, vh, 10)).toEqual({ x: 10, y: 10 });
  });
});

describe("isAction", () => {
  it("treats a row with no kind as an action", () => {
    const item: MenuItem = { label: "Open", onSelect: () => {} };
    expect(isAction(item)).toBe(true);
  });

  it("treats an explicit action as an action", () => {
    const item: MenuItem = { kind: "action", label: "Open", onSelect: () => {} };
    expect(isAction(item)).toBe(true);
  });

  it("rejects separators and submenus", () => {
    expect(isAction({ kind: "separator" })).toBe(false);
    expect(isAction({ kind: "submenu", key: "reset", label: "Reset", items: [] })).toBe(false);
  });
});

it("embeds existing actions without changing their checks, availability or callbacks", () => {
  const first = { label: "Name", checked: true, onSelect: () => {} };
  const second = { label: "Hidden", checked: false, disabled: true, onSelect: () => {} };
  const result = menuActions([
    { kind: "submenu", key: "view", label: "View", items: [
      { kind: "submenu", key: "sort", label: "Sort", items: [first, { kind: "separator" }] },
    ] },
    { kind: "separator" }, second,
  ]);
  expect(result).toEqual([first, second]);
  expect(result[0]).toBe(first);
  expect(result[1]).toBe(second);
});

it("tracks one expanded path, including repeated keys under different parents", () => {
  expect(menuPathOpen(["view", "sort"], ["view"])).toBe(true);
  expect(menuPathOpen(["view", "sort"], ["events", "sort"])).toBe(false);
  expect(menuPathOpen([], ["view"])).toBe(false);
  expect(toggleMenuPath(["view", "sort"], ["view", "columns"])).toEqual(["view", "columns"]);
  expect(toggleMenuPath(["view", "sort"], ["view", "sort"])).toEqual(["view"]);
  expect(toggleMenuPath(["view", "sort"], ["view"])).toEqual([]);
});
