import { afterEach, describe, expect, it, vi } from "vitest";
import { debounce, isHidden } from "./util";

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
