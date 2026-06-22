import { afterEach, describe, expect, it, vi } from "vitest";
import { debounce, isHidden, matchesQuery } from "./util";

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
