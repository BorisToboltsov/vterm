import { afterEach, describe, expect, it, vi } from "vitest";
import {
  debounce,
  filterHiddenFiles,
  isHidden,
  lineDiffStat,
  matchesQuery,
  suppressContextMenu,
} from "./util";

describe("lineDiffStat", () => {
  it("is 0/0 for identical text", () => {
    expect(lineDiffStat("a\nb\nc", "a\nb\nc")).toEqual({ added: 0, removed: 0 });
  });

  it("counts added and removed lines", () => {
    expect(lineDiffStat("a\nb", "a\nb\nc")).toEqual({ added: 1, removed: 0 });
    expect(lineDiffStat("a\nb\nc", "a\nc")).toEqual({ added: 0, removed: 1 });
    expect(lineDiffStat("a\nb\nc", "a\nX\nc")).toEqual({ added: 1, removed: 1 });
  });

  it("is order-insensitive (multiset) but counts net duplicates", () => {
    expect(lineDiffStat("a\na", "a")).toEqual({ added: 0, removed: 1 });
    expect(lineDiffStat("x\ny", "y\nx")).toEqual({ added: 0, removed: 0 });
  });
});

describe("suppressContextMenu", () => {
  it("prevents the native context menu default", () => {
    const e = { preventDefault: vi.fn() };
    suppressContextMenu(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("debounce", () => {
  afterEach(() => vi.useRealTimers());

  it("invokes once after the quiet period, with the latest args", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("cancel() prevents a pending call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("matchesQuery", () => {
  it("matches everything for an empty/whitespace query", () => {
    expect(matchesQuery("Appearance theme font", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });
  it("is case-insensitive and substring-based", () => {
    expect(matchesQuery("Host key policy known_hosts", "KEY")).toBe(true);
    expect(matchesQuery("Scrollback bell copy", "bell")).toBe(true);
  });
  it("requires every whitespace-separated term to be present", () => {
    expect(matchesQuery("Connection timeout keepalive port", "timeout port")).toBe(true);
    expect(matchesQuery("Connection timeout keepalive", "timeout nope")).toBe(false);
  });
});

describe("filterHiddenFiles", () => {
  const files = [
    { name: "app.js" },
    { name: ".env" },
    { name: "README.md" },
    { name: ".git" },
  ];

  it("drops dotfiles when showHidden is false", () => {
    expect(filterHiddenFiles(files, false).map((f) => f.name)).toEqual(["app.js", "README.md"]);
  });

  it("keeps everything (order preserved) when showHidden is true", () => {
    expect(filterHiddenFiles(files, true).map((f) => f.name)).toEqual([
      "app.js",
      ".env",
      "README.md",
      ".git",
    ]);
  });

  it("returns a fresh array, not the input reference", () => {
    expect(filterHiddenFiles(files, true)).not.toBe(files);
    expect(filterHiddenFiles([], false)).toEqual([]);
  });
});

describe("isHidden", () => {
  afterEach(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });

  it("reflects document.visibilityState", () => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    expect(isHidden()).toBe(true);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    expect(isHidden()).toBe(false);
  });
});
