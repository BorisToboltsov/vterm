import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearToasts,
  dismissToast,
  notify,
  notifyError,
  notifyInfo,
  notifySuccess,
  TOAST_TTL,
  toastsState,
} from "./toasts.svelte";

describe("toasts store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });
  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it("notify adds a toast and returns its id", () => {
    const id = notify("hi", "info");
    expect(toastsState.list).toHaveLength(1);
    expect(toastsState.list[0]).toMatchObject({ id, kind: "info", message: "hi" });
  });

  it("kind helpers set the kind", () => {
    notifyError("e");
    notifySuccess("s");
    notifyInfo("i");
    expect(toastsState.list.map((t) => t.kind)).toEqual(["error", "success", "info"]);
  });

  it("auto-dismisses after the per-kind TTL", () => {
    notifySuccess("done");
    expect(toastsState.list).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_TTL.success - 1);
    expect(toastsState.list).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toastsState.list).toHaveLength(0);
  });

  it("respects a custom ttl and treats 0 as sticky", () => {
    notify("sticky", "info", 0);
    vi.advanceTimersByTime(60_000);
    expect(toastsState.list).toHaveLength(1);
  });

  it("dismissToast removes a specific toast and cancels its timer", () => {
    const id = notifyError("boom");
    dismissToast(id);
    expect(toastsState.list).toHaveLength(0);
    // The cancelled timer must not fire or throw later.
    vi.advanceTimersByTime(TOAST_TTL.error);
    expect(toastsState.list).toHaveLength(0);
  });

  it("clearToasts empties the queue", () => {
    notifyInfo("a");
    notifyInfo("b");
    expect(toastsState.list).toHaveLength(2);
    clearToasts();
    expect(toastsState.list).toHaveLength(0);
  });
});
