import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  writeToTerminal: vi.fn(async (_id: string, _data: Uint8Array) => {}),
  setServerPathSync: vi.fn(async (id: string, mode: string | null) => ({ id, pathSync: mode }) as unknown),
}));
vi.mock("../api", () => api);
const toasts = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("../stores/toasts.svelte", () => toasts);

import { createPathSyncFlow, type PathSyncFlow } from "./pathsyncflow.svelte";
import { settings } from "../settings/settings.svelte";
import { OSC7_SETUP } from "../pathsync/shellintegration";
import { submitLine } from "../terminal/terminput";
import type { Tab } from "../stores/tabs.svelte";
import type { ServerProfile } from "../types";

const DELAY = 500;

const tab = (sessionId: string, over: Partial<Tab> = {}): Tab =>
  ({
    sessionId,
    kind: "ssh",
    serverId: `srv-${sessionId}`,
    alias: sessionId,
    status: "Connected",
    gen: 0,
    ...over,
  }) as Tab;

const server = (id: string, pathSync: string | null | undefined): ServerProfile =>
  ({ id, alias: `alias-${id}`, pathSync }) as ServerProfile;

/** The bytes of the setup command, as typed into a shell. */
const SETUP = Array.from(new TextEncoder().encode(submitLine(OSC7_SETUP)));
const typed = () => api.writeToTerminal.mock.calls.map(([id, data]) => [id, Array.from(data)]);

function harness(tabs: Tab[], servers: ServerProfile[], cwd: Record<string, string> = {}) {
  const state = $state({ tabs, servers });
  const saved = vi.fn((s: ServerProfile) => {
    state.servers = state.servers.map((x) => (x.id === s.id ? s : x));
  });
  const forgetCwd = vi.fn((id: string) => delete cwd[id]);
  let flow!: PathSyncFlow;
  const cleanup = $effect.root(() => {
    flow = createPathSyncFlow({
      findTab: (id) => state.tabs.find((t) => t.sessionId === id),
      servers: () => state.servers,
      serverSaved: saved,
      isProd: (id) => id === "prod",
      terminalCwd: (id) => cwd[id] ?? null,
      forgetCwd,
      promptDelayMs: DELAY,
    });
  });
  flushSync();
  return { flow, state, saved, forgetCwd, cleanup };
}

const localBefore = settings.localPathSync;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  settings.localPathSync = localBefore;
});

describe("path sync flow: turning it on", () => {
  it("a server without an answer asks first and follows nothing until answered", () => {
    const { flow, cleanup } = harness([tab("a"), tab("prod")], [server("srv-a", null), server("srv-prod", null)]);
    flow.enable("a");
    expect(flow.ask).toEqual({ sessionId: "a", kind: "ssh", target: "alias-srv-a", prod: false, needsSetup: true });
    expect(flow.following.a).toBeFalsy();
    expect(typed()).toEqual([]);
    flow.cancel();
    flow.enable("prod");
    expect(flow.ask?.prod).toBe(true);
    cleanup();
  });

  it("an answer it does not know reads as no answer — it asks, never types unasked", () => {
    const { flow, cleanup } = harness([tab("a")], [server("srv-a", "always-and-forever")]);
    flow.enable("a");
    expect(flow.ask?.sessionId).toBe("a");
    expect(typed()).toEqual([]);
    cleanup();
  });

  it("a server that answered starts at once, typing the setup into a shell that reported nothing", () => {
    const { flow, cleanup } = harness([tab("a"), tab("b")], [server("srv-a", "auto"), server("srv-b", "manual")], {
      b: "/srv",
    });
    flow.enable("a");
    flow.enable("b");
    expect(flow.ask).toBeNull();
    expect([flow.following.a, flow.following.b]).toEqual([true, true]);
    // b's shell already reports its folder: nothing to type there.
    expect(typed()).toEqual([["a", SETUP]]);
    expect(flow.integrated("a")).toBe(true);
    cleanup();
  });

  it("a local tab reads its answer from settings and never needs the setup", () => {
    settings.localPathSync = "manual";
    const { flow, cleanup } = harness([tab("l", { kind: "local" })], []);
    expect(flow.needsSetup("l")).toBe(false);
    flow.enable("l");
    expect(flow.following.l).toBe(true);
    expect(typed()).toEqual([]);
    cleanup();
  });

  it("the dock's switch turns off at once and on through the question", () => {
    const { flow, cleanup } = harness([tab("a")], [server("srv-a", "manual")]);
    flow.toggle("a");
    expect(flow.following.a).toBe(true);
    flow.toggle("a");
    expect(flow.following.a).toBe(false);
    cleanup();
    const asking = harness([tab("q")], [server("srv-q", null)]);
    asking.flow.toggle("q");
    expect(asking.flow.ask?.sessionId).toBe("q");
    expect(asking.flow.following.q).toBeFalsy();
    asking.cleanup();
  });

  it("the setup is typed once per shell", () => {
    const { flow, cleanup } = harness([tab("a")], [server("srv-a", "manual")]);
    flow.enable("a");
    flow.toggle("a");
    flow.toggle("a");
    expect(typed()).toEqual([["a", SETUP]]);
    expect(flow.needsSetup("a")).toBe(false);
    cleanup();
  });

  it("following is read-only outside the flow", () => {
    const { flow, cleanup } = harness([], []);
    // Compile-time: the page cannot start following past `start`.
    const neverRun = () => {
      // @ts-expect-error — following is read-only outside the flow
      flow.following.a = true;
    };
    expect(typeof neverRun).toBe("function");
    cleanup();
  });
});

describe("path sync flow: the question's answer", () => {
  it("'this time' follows and saves nothing", async () => {
    const { flow, saved, cleanup } = harness([tab("a")], [server("srv-a", null)]);
    flow.enable("a");
    await flow.answer("once");
    expect(flow.ask).toBeNull();
    expect(flow.following.a).toBe(true);
    expect(typed()).toEqual([["a", SETUP]]);
    expect(api.setServerPathSync).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    cleanup();
  });

  it("'always' and 'by hand' are saved in the server's profile", async () => {
    const { flow, state, cleanup } = harness([tab("a"), tab("b")], [server("srv-a", null), server("srv-b", null)]);
    flow.enable("a");
    await flow.answer("always");
    flow.enable("b");
    await flow.answer("manual");
    expect(api.setServerPathSync.mock.calls).toEqual([
      ["srv-a", "auto"],
      ["srv-b", "manual"],
    ]);
    expect(state.servers.map((s) => s.pathSync)).toEqual(["auto", "manual"]);
    cleanup();
  });

  it("a local tab's lasting answer goes to settings, not the backend", async () => {
    settings.localPathSync = "ask";
    const { flow, cleanup } = harness([tab("l", { kind: "local" })], []);
    flow.enable("l");
    expect(flow.ask?.target).toBeNull();
    await flow.answer("always");
    expect(settings.localPathSync).toBe("auto");
    expect(api.setServerPathSync).not.toHaveBeenCalled();
    expect(flow.following.l).toBe(true);
    cleanup();
  });

  it("a failed save leaves following on and says why", async () => {
    api.setServerPathSync.mockRejectedValueOnce(new Error("disk full"));
    const { flow, cleanup } = harness([tab("a")], [server("srv-a", null)]);
    flow.enable("a");
    await flow.answer("always");
    expect(flow.following.a).toBe(true);
    expect(toasts.notifyError).toHaveBeenCalledTimes(1);
    expect(String(toasts.notifyError.mock.calls[0][0])).toContain("disk full");
    cleanup();
  });

  it("an answer for a tab that has gone does nothing", async () => {
    const { flow, state, cleanup } = harness([tab("a")], [server("srv-a", null)]);
    flow.enable("a");
    state.tabs = [];
    await flow.answer("always");
    expect(flow.following.a).toBeFalsy();
    expect(api.setServerPathSync).not.toHaveBeenCalled();
    cleanup();
  });
});

describe("path sync flow: connect and end of a session", () => {
  it("'always' types the setup into a fresh SSH shell once its prompt is up", () => {
    const { flow, cleanup } = harness([tab("a")], [server("srv-a", "auto")]);
    flow.connected(tab("a"), { attach: false, pendingCommand: false });
    expect(flow.following.a).toBeFalsy();
    vi.advanceTimersByTime(DELAY);
    expect(flow.following.a).toBe(true);
    expect(typed()).toEqual([["a", SETUP]]);
    cleanup();
  });

  it("not into a shell that runs a program of its own, and not after the session dropped", () => {
    const { flow, state, cleanup } = harness([tab("c"), tab("p"), tab("d")], [
      server("srv-c", "auto"),
      server("srv-p", "auto"),
      server("srv-d", "auto"),
    ]);
    flow.connected(tab("c"), { attach: true, pendingCommand: false });
    flow.connected(tab("p"), { attach: false, pendingCommand: true });
    flow.connected(tab("d"), { attach: false, pendingCommand: false });
    state.tabs = state.tabs.map((x) => (x.sessionId === "d" ? { ...x, status: "Disconnected" } : x));
    vi.advanceTimersByTime(DELAY);
    expect([flow.following.c, flow.following.p, flow.following.d]).toEqual([undefined, undefined, undefined]);
    expect(typed()).toEqual([]);
    cleanup();
  });

  it("'ask' and 'by hand' do nothing on connect; a local 'always' follows at once", () => {
    settings.localPathSync = "auto";
    const { flow, cleanup } = harness([tab("q"), tab("m"), tab("l", { kind: "local" })], [
      server("srv-q", null),
      server("srv-m", "manual"),
    ]);
    const none = { attach: false, pendingCommand: false };
    flow.connected(tab("q"), none);
    flow.connected(tab("m"), none);
    flow.connected(tab("l", { kind: "local" }), none);
    expect(flow.following.l).toBe(true);
    vi.advanceTimersByTime(DELAY);
    expect([flow.following.q, flow.following.m]).toEqual([undefined, undefined]);
    expect(typed()).toEqual([]);
    cleanup();
  });

  it("the end of a session stops following and forgets its shell", () => {
    const { flow, forgetCwd, cleanup } = harness([tab("a"), tab("b")], [server("srv-a", "manual"), server("srv-b", null)]);
    flow.enable("a");
    flow.enable("b");
    flow.closed("a");
    flow.closed("b");
    expect(flow.following.a).toBe(false);
    expect(flow.needsSetup("a")).toBe(true);
    expect(flow.ask).toBeNull();
    expect(forgetCwd.mock.calls).toEqual([["a"], ["b"]]);
    // The new shell knows nothing typed into the old one.
    flow.enable("a");
    expect(typed()).toEqual([
      ["a", SETUP],
      ["a", SETUP],
    ]);
    cleanup();
  });

  it("a tab from another window keeps what it carried, without typing anything", () => {
    const { flow, cleanup } = harness([tab("w")], [server("srv-w", null)]);
    flow.adopt("w", { following: true, integrated: true });
    expect(flow.following.w).toBe(true);
    expect(flow.integrated("w")).toBe(true);
    expect(typed()).toEqual([]);
    flow.forget("w");
    expect([flow.following.w, flow.integrated("w")]).toEqual([undefined, false]);
    cleanup();
  });
});
