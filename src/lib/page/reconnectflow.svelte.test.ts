import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../stores/toasts.svelte", () => ({
  notifyInfo: (text: string) => toasts.push(text),
  notifyError: (text: string) => toasts.push(text),
}));

import { createReconnectFlow } from "./reconnectflow.svelte";
import { RECONNECT_DELAYS_MS, STABLE_MS } from "../connect/reconnect";
import { captureDiag } from "../api/diag";

/** What the diagnostics heard: level and text. */
let heard: ReturnType<typeof captureDiag>;
const events = () => heard.events().map((e) => ({ level: e.level, text: e.text, sid: e.sid }));

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
    toasts.length = 0;
    heard = captureDiag();
  });
  afterEach(() => {
    vi.useRealTimers();
    heard.stop();
    // Told the diagnostics, never the user: the tab's own screen says where it stands.
    expect(toasts).toEqual([]);
  });

  it("reconnects a dropped session after its pause, telling the diagnostics", () => {
    const f = flow();
    f.status("s1", "connected");
    clock += STABLE_MS + 1;
    f.status("s1", "closed");
    expect(f.waiting("s1")).toBe(true);
    expect(events()).toEqual([{ level: "info", text: "reconnect attempt 1 of 6 in 1 s", sid: "s1" }]);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0] - 1);
    expect(reconnects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reconnects).toEqual(["s1"]);
    // Its own attempt connecting keeps the count; connected, the diagnostics hear it.
    f.status("s1", "connecting");
    f.status("s1", "connected");
    expect(events().at(-1)?.text).toBe("reconnected after 1 attempts");
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
    expect(events().at(-1)).toEqual({
      level: "warn",
      text: "reconnect gave up after 6 attempts: Connection refused",
      sid: "s1",
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
    expect(events()).toEqual([{ level: "info", text: "session closed", sid: "s1" }]);
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
