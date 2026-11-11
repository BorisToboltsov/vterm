import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notes = vi.hoisted(() => [] as unknown[]);
vi.mock("./journal.svelte", () => ({ noteJournal: (n: unknown) => notes.push(n) }));

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
import { openLocalTab, openTab, resetTabs } from "./tabs.svelte";

describe("toasts store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
    notes.length = 0;
  });
  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it("notify adds a toast and returns its id", () => {
    const id = notify("hi", "info");
    expect(toastsState.list).toHaveLength(1);
    expect(toastsState.list[0]).toMatchObject({ id, kind: "info", message: "hi", count: 1 });
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
    notify("sticky", "info", { ttl: 0 });
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

  it("the same message said again counts up on one toast, the newest, kept up anew", () => {
    const first = notifyError("exec channel failed", { source: "docker" });
    notifyError("between");
    vi.advanceTimersByTime(TOAST_TTL.error - 100);
    const again = notifyError("exec channel failed", { source: "docker" });
    expect(again).toBe(first);
    expect(toastsState.list.map((t) => [t.message, t.count])).toEqual([
      ["between", 1],
      ["exec channel failed", 2],
    ]);
    // Its delay starts over: still up after the first one would have run out.
    vi.advanceTimersByTime(200);
    expect(toastsState.list.some((t) => t.id === first)).toBe(true);
    vi.advanceTimersByTime(TOAST_TTL.error);
    expect(toastsState.list.some((t) => t.id === first)).toBe(false);
    // Every saying is in the journal, counted there.
    expect(notes).toHaveLength(3);
  });

  it("a message differs by tone and source", () => {
    notifyError("x", { source: "docker" });
    notifyError("x", { source: "k8s" });
    notifyInfo("x", { source: "docker" });
    expect(toastsState.list).toHaveLength(3);
  });

  it("a quiet note goes to the journal only", () => {
    expect(notifyError("poll failed", { quiet: true, source: "docker" })).toBe("");
    expect(toastsState.list).toHaveLength(0);
    expect(notes).toEqual([{ kind: "error", text: "poll failed", source: "docker", serverId: undefined, server: undefined }]);
  });

  it("the journal gets the message masked, and the server of its session", () => {
    const ssh = openTab("srv-9", "prod-db", null, false);
    const local = openLocalTab();
    notifyError("token=ghp_abcdefghijklmnopqrstuvwxyz0123 refused", { sessionId: ssh, source: "git" });
    notifyInfo("ok", { sessionId: local });
    notifyInfo("nowhere", { sessionId: "gone" });
    const [masked, fromLocal, fromNowhere] = notes as { text: string; serverId?: string; server?: string }[];
    expect(masked.text).not.toContain("ghp_");
    expect(masked).toMatchObject({ serverId: "srv-9", server: "prod-db" });
    expect(fromLocal.serverId).toBeUndefined();
    expect(fromLocal.server).toBeTruthy();
    expect(fromNowhere).toMatchObject({ serverId: undefined, server: undefined });
    // The toast names the server too, and keeps its own words unmasked.
    expect(toastsState.list[0]).toMatchObject({ server: "prod-db", source: "git" });
    expect(toastsState.list[0].message).toContain("ghp_");
    resetTabs();
  });
});
