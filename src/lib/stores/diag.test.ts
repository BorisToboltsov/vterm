import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagNews, DiagPage, DiagState } from "../types";

const h = vi.hoisted(() => ({
  listener: null as ((e: { payload: DiagNews }) => void) | null,
  state: { level: "info", sizeMb: 25, panics: 0, bytes: 10, error: null, folder: "/d" } as DiagState,
  threshold: [] as string[],
  events: [] as { level: string; text: string }[],
  toasts: [] as string[],
  queries: [] as unknown[],
  page: { events: [], more: false, counts: {}, total: 0, unreadable: 0 } as DiagPage,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, fn: (e: { payload: DiagNews }) => void) => {
    h.listener = fn;
    return () => (h.listener = null);
  },
}));
vi.mock("../api/diag", () => ({
  DIAG_EVENT: "window://diag",
  diag: {
    error: (_s: string, text: string) => h.events.push({ level: "error", text }),
    warn: (_s: string, text: string) => h.events.push({ level: "warn", text }),
  },
  diagState: async () => h.state,
  diagSetLevel: async (level: string) => ({ ...h.state, level }),
  diagSetSize: async (sizeMb: number) => ({ ...h.state, sizeMb }),
  diagQuery: async (q: unknown) => {
    h.queries.push(q);
    return h.page;
  },
  diagClear: async () => {
    h.state = { ...h.state, bytes: 0 };
    return h.state;
  },
  flushDiag: () => {},
  setDiagThreshold: (l: string) => h.threshold.push(l),
}));
vi.mock("./toasts.svelte", () => ({ notifyError: (text: string) => h.toasts.push(text) }));

import { clearDiag, diagState, loadDiag, loadOlderDiag, setDiagLevel, setDiagSize, startDiag } from "./diag.svelte";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the diagnostics store", () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    h.threshold.length = 0;
    h.events.length = 0;
    h.toasts.length = 0;
    h.queries.length = 0;
    h.state = { level: "info", sizeMb: 25, panics: 0, bytes: 10, error: null, folder: "/d" };
  });
  afterEach(() => stop());

  it("takes the threshold the backend says and gives it to the facade", async () => {
    h.state = { ...h.state, level: "warn" };
    stop = startDiag(true);
    await settle();
    expect(diagState.level).toBe("warn");
    h.listener?.({ payload: { level: "debug", sizeMb: 100, panics: 0 } });
    expect(h.threshold.at(-1)).toBe("debug");
    expect(diagState.sizeMb).toBe(100);
  });

  it("the main window tells a new panic of the backend, once a minute at most", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000_000);
    h.state = { ...h.state, panics: 2 };
    stop = startDiag(true);
    await settle();
    // Panics before this window began are not its to tell.
    expect(h.toasts).toEqual([]);
    h.listener?.({ payload: { level: "info", sizeMb: 25, panics: 3 } });
    h.listener?.({ payload: { level: "info", sizeMb: 25, panics: 4 } });
    expect(h.toasts).toHaveLength(1);
    vi.setSystemTime(10_000_000 + 60_000);
    h.listener?.({ payload: { level: "info", sizeMb: 25, panics: 5 } });
    expect(h.toasts).toHaveLength(2);
    vi.useRealTimers();
  });

  it("another window leaves the backend's panics to the main one", async () => {
    stop = startDiag(false);
    await settle();
    h.listener?.({ payload: { level: "info", sizeMb: 25, panics: 1 } });
    expect(h.toasts).toEqual([]);
  });

  it("writes this window's uncaught errors and unhandled rejections", async () => {
    stop = startDiag(false);
    await settle();
    window.dispatchEvent(new ErrorEvent("error", { message: "x is undefined", error: new Error("x is undefined") }));
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: "nobody caught me" });
    window.dispatchEvent(rejection);
    expect(h.events).toEqual([
      { level: "error", text: "uncaught error: x is undefined" },
      { level: "error", text: "unhandled rejection: nobody caught me" },
    ]);
  });

  it("reads pages by the filter, older under newer, and clears", async () => {
    h.page = { events: [{ at: 5, level: "warn", text: "b" }], more: true, counts: { level: { warn: 1 } }, total: 9, unreadable: 0 };
    await loadDiag({ text: "x", facets: { level: ["warn"] } });
    expect(diagState.events.map((e) => e.text)).toEqual(["b"]);
    expect(h.queries.at(-1)).toMatchObject({ levels: ["warn"], text: "x", before: null });
    h.page = { events: [{ at: 2, level: "warn", text: "a" }], more: false, counts: {}, total: 9, unreadable: 0 };
    await loadOlderDiag();
    expect(h.queries.at(-1)).toMatchObject({ before: 5 });
    expect(diagState.events.map((e) => e.text)).toEqual(["b", "a"]);
    expect(diagState.more).toBe(false);
    await setDiagLevel("error");
    expect(diagState.level).toBe("error");
    await setDiagSize(50);
    expect(diagState.sizeMb).toBe(50);
    await clearDiag();
    expect(diagState.files?.bytes).toBe(0);
  });
});
