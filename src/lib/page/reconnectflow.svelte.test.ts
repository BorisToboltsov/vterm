import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notes = vi.hoisted(() => [] as { kind: string; text: string; opts: unknown }[]);
vi.mock("../stores/toasts.svelte", () => ({
  notifyInfo: (text: string, opts: unknown) => notes.push({ kind: "info", text, opts }),
  notifyError: (text: string, opts: unknown) => notes.push({ kind: "error", text, opts }),
}));

import { createReconnectFlow } from "./reconnectflow.svelte";
import { RECONNECT_DELAYS_MS, STABLE_MS } from "../connect/reconnect";

describe("the reconnect flow", () => {
  let auto = true;
  let tabs = new Set<string>();
  let reconnects: string[] = [];
  let clock = 0;
  const flow = () =>
    createReconnectFlow({
      auto: () => auto,
      exists: (id) => tabs.has(id),
      reconnect: (id) => reconnects.push(id),
      now: () => clock,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    auto = true;
    tabs = new Set(["s1"]);
    reconnects = [];
    clock = 1_000_000;
    notes.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("reconnects a dropped session after its pause, quietly telling the journal", () => {
    const f = flow();
    f.status("s1", "connected");
    clock += STABLE_MS + 1;
    f.status("s1", "closed");
    expect(f.waiting("s1")).toBe(true);
    expect(notes).toEqual([
      { kind: "info", text: "Reconnecting: attempt 1 of 6 in 1 s", opts: { source: "connection", sessionId: "s1", quiet: true } },
    ]);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0] - 1);
    expect(reconnects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reconnects).toEqual(["s1"]);
    // Its own attempt connecting keeps the count; connected, the journal hears it.
    f.status("s1", "connecting");
    f.status("s1", "connected");
    expect(notes.at(-1)?.text).toBe("Reconnected on attempt 1");
  });

  it("tries again after each failed attempt, longer each time, and gives up at the end", () => {
    const f = flow();
    f.status("s1", "connected");
    clock += STABLE_MS;
    f.status("s1", "closed");
    for (let i = 0; i < RECONNECT_DELAYS_MS.length; i++) {
      vi.advanceTimersByTime(RECONNECT_DELAYS_MS[i]);
      f.status("s1", "connecting");
      f.status("s1", "error", "Connection refused");
    }
    expect(reconnects).toHaveLength(RECONNECT_DELAYS_MS.length);
    expect(f.waiting("s1")).toBe(false);
    expect(notes.at(-1)).toEqual({
      kind: "error",
      text: "Couldn't reconnect, attempts: 6. Connection refused",
      opts: { source: "connection", sessionId: "s1", quiet: true },
    });
    vi.advanceTimersByTime(60_000);
    expect(reconnects).toHaveLength(RECONNECT_DELAYS_MS.length);
  });

  it("a connect the user starts clears the count and the attempt that was waiting", () => {
    const f = flow();
    f.status("s1", "connected");
    clock += STABLE_MS;
    f.status("s1", "closed");
    // The tab's own button, before the pause ended.
    f.status("s1", "connecting");
    expect(f.waiting("s1")).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(reconnects).toEqual([]);
    // Its failure is the user's: nothing is retried.
    f.status("s1", "error", "Connection refused");
    expect(f.waiting("s1")).toBe(false);
  });

  it("without the setting, a drop is only noted", () => {
    auto = false;
    const f = flow();
    f.status("s1", "connected");
    f.status("s1", "closed");
    expect(f.waiting("s1")).toBe(false);
    expect(notes).toEqual([
      { kind: "info", text: "The session ended", opts: { source: "connection", sessionId: "s1", quiet: true } },
    ]);
    f.status("s1", "error", "x");
    vi.advanceTimersByTime(60_000);
    expect(reconnects).toEqual([]);
  });

  it("a closed tab takes its waiting attempt with it", () => {
    const f = flow();
    f.status("s1", "connected");
    clock += STABLE_MS;
    f.status("s1", "closed");
    f.forget("s1");
    vi.advanceTimersByTime(60_000);
    expect(reconnects).toEqual([]);
    // A tab gone by the time its pause ends is not dialled either.
    f.status("s1", "connected");
    clock += STABLE_MS;
    f.status("s1", "closed");
    tabs.delete("s1");
    vi.advanceTimersByTime(60_000);
    expect(reconnects).toEqual([]);
  });
});
