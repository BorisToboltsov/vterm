import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every call the backend got, in order. */
const calls: string[] = [];
const api = vi.hoisted(() => ({
  announceWindow: vi.fn(async (..._a: unknown[]) => {}),
  closeWindow: vi.fn(async () => {}),
  declineHandoff: vi.fn(async (..._a: unknown[]) => {}),
  detachAbort: vi.fn(async (..._a: unknown[]) => {}),
  detachBegin: vi.fn(async (..._a: unknown[]) => 7),
  detachCommit: vi.fn(async (..._a: unknown[]): Promise<string> => "win-2"),
  dragDrop: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
  dragEnd: vi.fn(async () => {}),
  dragOver: vi.fn(async (..._a: unknown[]) => null),
  takeHandoff: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("../api", () => api);
const env = vi.hoisted(() => ({ main: true }));
vi.mock("../appwindow", () => ({
  get isMainWindow() {
    return env.main;
  },
  windowLabel: "main",
  otherWindows: (payload: unknown) => (payload as { label: string; title: string; tabs: number }[]) ?? [],
  windowTarget: (w: { label: string }) => ({ key: "window.target", params: { name: w.label } }),
}));
const drag = vi.hoisted(() => ({
  host: null as null | {
    release: (id: string, at: { x: number; y: number }, outside: boolean) => void;
    over: (id: string) => Promise<unknown>;
    left: () => void;
  },
  state: { outside: false, window: null as string | null },
  incomingDrop: null as unknown,
}));
vi.mock("../stores/tabdrag.svelte", () => ({
  onTabDraggedOutside: (h: typeof drag.host) => (drag.host = h),
  tabDrag: drag.state,
}));
vi.mock("../stores/tabincoming.svelte", () => ({
  describeTab: (tab: { sessionId: string }) => ({ id: tab.sessionId }),
  takeIncomingDrop: () => drag.incomingDrop,
}));
const toasts = vi.hoisted(() => ({ notifyInfo: vi.fn(), notifyError: vi.fn() }));
vi.mock("../stores/toasts.svelte", () => toasts);

import { createWindowFlow, type WindowFlow } from "./windowflow.svelte";
import { findTab, openLocalTab, resetTabs, setTabStatus, splitTabOff, tabsState } from "../stores/tabs.svelte";
import type { PageFacts } from "../stores/tabpacket";

const FACTS: PageFacts = { terminalCwd: "/srv", followTerminal: true, followSeen: null, localShell: "posix", shellIntegrated: false };

/** A tab of this window whose session is up. */
function connectedTab(): string {
  const id = openLocalTab();
  setTabStatus(id, "connected");
  return id;
}

const settled = () => new Promise((r) => setTimeout(r, 0));

function harness(over: { editorBusy?: (id: string) => boolean; snapshot?: (id: string, sent: number) => Promise<unknown> } = {}) {
  const deps = {
    title: vi.fn((tab: { sessionId: string }) => `title-${tab.sessionId.slice(0, 4)}`),
    alias: vi.fn(() => "alias"),
    editorBusy: over.editorBusy ?? (() => false),
    snapshot: vi.fn(
      over.snapshot ??
        (async (id: string, sent: number) => {
          calls.push(`snapshot ${sent}`);
          void id;
          return { cols: 80, rows: 24, data: "$ ", commands: [] };
        }),
    ),
    carried: vi.fn(() => FACTS),
    arrived: vi.fn(),
    teardown: vi.fn((id: string, keep: boolean) => calls.push(`teardown ${keep}`) && void id),
    refreshTransfers: vi.fn(),
    ghostProbe: () => undefined,
    areaBounds: () => ({ width: 1200, height: 800 }),
  };
  let flow!: WindowFlow;
  const cleanup = $effect.root(() => {
    flow = createWindowFlow(deps as never);
  });
  flushSync();
  return { flow, deps, cleanup };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  resetTabs();
  env.main = true;
  drag.host = null;
  drag.state.outside = false;
  drag.state.window = null;
  drag.incomingDrop = null;
  api.detachBegin.mockImplementation(async () => (calls.push("begin"), 7));
  api.detachCommit.mockImplementation(async () => (calls.push("commit"), "win-2"));
  api.detachAbort.mockImplementation(async () => void calls.push("abort"));
});

describe("window flow: the trip", () => {
  it("holds the output, snapshots once it has all of it, waits for the other window, and only then lets the tab go", async () => {
    const id = connectedTab();
    connectedTab();
    const { flow, deps, cleanup } = harness();
    expect(await flow.detachTab(id)).toBe(true);
    expect(calls).toEqual(["begin", "snapshot 7", "commit", "teardown true"]);
    expect(deps.teardown).toHaveBeenCalledWith(id, true);
    const packet = JSON.parse(api.detachCommit.mock.calls[0][1] as string);
    expect(packet.page).toMatchObject({ terminalCwd: "/srv", followTerminal: true });
    expect(flow.detaching).toBeNull();
    cleanup();
  });

  it("a failed trip gives the held output back and keeps the tab", async () => {
    const id = connectedTab();
    connectedTab();
    api.detachCommit.mockRejectedValueOnce(new Error("handoff-timeout"));
    const { flow, deps, cleanup } = harness();
    expect(await flow.detachTab(id)).toBe(false);
    expect(calls).toEqual(["begin", "snapshot 7", "abort"]);
    expect(deps.teardown).not.toHaveBeenCalled();
    expect(toasts.notifyError).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("no snapshot, no trip — and the output is given back", async () => {
    const id = connectedTab();
    connectedTab();
    const { flow, deps, cleanup } = harness({ snapshot: async () => null });
    expect(await flow.detachTab(id)).toBe(false);
    expect(calls).toEqual(["begin", "abort"]);
    expect(deps.teardown).not.toHaveBeenCalled();
    cleanup();
  });

  it("a tab is asked whether it may go before anything is held", async () => {
    const down = openLocalTab();
    const busy = connectedTab();
    const { flow, cleanup } = harness({ editorBusy: (id) => id === busy });
    expect(await flow.detachTab(down)).toBe(false);
    expect(await flow.detachTab(busy)).toBe(false);
    expect(api.detachBegin).not.toHaveBeenCalled();
    expect(toasts.notifyInfo).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("the only tab of a secondary window may go back to an open window, not to a new one", async () => {
    env.main = false;
    const id = connectedTab();
    const { flow, cleanup } = harness();
    expect(await flow.detachTab(id)).toBe(false);
    expect(api.detachBegin).not.toHaveBeenCalled();
    expect(await flow.detachTab(id, { window: "main" })).toBe(true);
    expect(api.detachCommit.mock.calls[0][2]).toMatchObject({ target: "main" });
    cleanup();
  });
});

describe("window flow: a tab dropped outside", () => {
  it("is shown to nobody when it cannot go, and its drop says why — and ends the drag", async () => {
    const id = openLocalTab(); // not connected
    connectedTab();
    const { cleanup } = harness();
    expect(await drag.host!.over(id)).toBeNull();
    drag.host!.release(id, { x: 1, y: 1 }, true);
    await settled();
    expect(api.dragOver).not.toHaveBeenCalled();
    expect(api.dragEnd).toHaveBeenCalledTimes(1);
    expect(api.detachBegin).not.toHaveBeenCalled();
    expect(toasts.notifyInfo).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("reordered in its own strip with no other window, it asks nobody", async () => {
    const id = connectedTab();
    connectedTab();
    const { cleanup } = harness();
    expect(await drag.host!.over(id)).toBeNull();
    drag.state.outside = true;
    await drag.host!.over(id);
    expect(api.dragOver).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("goes where the release says, not where it was last drawn — and a failed trip there is said", async () => {
    const id = connectedTab();
    connectedTab();
    const { flow, cleanup } = harness();
    flow.heardWindows([{ label: "win-2", title: "x", tabs: 1 }]);
    flushSync();
    drag.state.window = "win-9"; // drawn last over another window
    api.dragDrop.mockResolvedValueOnce("win-2");
    api.detachCommit.mockRejectedValueOnce(new Error("handoff-timeout"));
    drag.host!.release(id, { x: 5, y: 5 }, true);
    await settled();
    await settled();
    expect(api.detachCommit.mock.calls[0][2]).toMatchObject({ target: "win-2" });
    // The window it was dropped on kept a place for it: told that it is not coming.
    expect(api.dragEnd).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("over the desktop it opens a window of its own; every release asks the backend", async () => {
    const id = connectedTab();
    connectedTab();
    const { cleanup } = harness();
    drag.host!.release(id, { x: 300, y: 200 }, true);
    await settled();
    await settled();
    expect(api.dragDrop).toHaveBeenCalledTimes(1);
    expect(api.detachCommit.mock.calls[0][2]).toMatchObject({ x: 300, y: 200, target: undefined });
    cleanup();
  });

  it("back in its window the other one stops drawing it", () => {
    connectedTab();
    connectedTab();
    const { cleanup } = harness();
    drag.host!.left();
    expect(api.dragEnd).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("is no drop target at all where it cannot leave, and none after the page", () => {
    env.main = false;
    connectedTab();
    const { cleanup } = harness();
    expect(drag.host).toBeNull();
    cleanup();
    env.main = true;
    connectedTab();
    const h = harness();
    expect(drag.host).not.toBeNull();
    h.cleanup();
    expect(drag.host).toBeNull();
  });
});

describe("window flow: an open window taking a tab", () => {
  it("says it takes tabs only once it listens for the offer of one", async () => {
    connectedTab();
    const { flow, cleanup } = harness();
    expect(api.announceWindow).not.toHaveBeenCalled();
    flow.listening();
    flushSync();
    expect(api.announceWindow).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("a tab offered and taken lands where the window kept its place, with its transfers", async () => {
    const id = connectedTab();
    const { flow, deps, cleanup } = harness();
    // The tab's packet, as the other window would send it.
    let packet = "";
    api.detachCommit.mockImplementationOnce(async (_id, p) => ((packet = p as string), "win-2"));
    connectedTab();
    await flow.detachTab(id);
    resetTabs();
    api.takeHandoff.mockResolvedValueOnce(packet);
    const kept = { pane: tabsState.center.focus, edge: null };
    drag.incomingDrop = kept;
    await flow.receiveTab();
    expect(findTab(id)).not.toBeNull();
    expect(deps.arrived).toHaveBeenCalledWith(id, expect.objectContaining({ terminalCwd: "/srv" }));
    expect(deps.refreshTransfers).toHaveBeenCalledTimes(1);
    expect(api.declineHandoff).not.toHaveBeenCalled();
    expect(api.closeWindow).not.toHaveBeenCalled();
    cleanup();
  });

  it("an offer with nothing to take is declined at once, and the window stays", async () => {
    connectedTab();
    const { flow, cleanup } = harness();
    await flow.receiveTab();
    expect(api.declineHandoff).toHaveBeenCalledTimes(1);
    expect(api.closeWindow).not.toHaveBeenCalled();
    cleanup();
  });

  it("a tab that did not arrive is declined and dropped without its session; only an empty secondary window goes", () => {
    env.main = false;
    const mine = connectedTab();
    const late = connectedTab();
    const { flow, deps, cleanup } = harness();
    flow.adoptFailed(late);
    expect(api.declineHandoff).toHaveBeenCalledWith(late);
    expect(deps.teardown).toHaveBeenCalledWith(late, true);
    // This window still has its own tab (the teardown here is a stub that removes nothing).
    resetTabs();
    flow.adoptFailed(mine);
    expect(api.closeWindow).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("a secondary window with nothing to take goes", async () => {
    env.main = false;
    const { flow, cleanup } = harness();
    await flow.adoptHandoff();
    expect(api.closeWindow).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("window flow: a pane moving whole", () => {
  function pane(n: number): { pane: string; tabs: string[] } {
    const tabs = Array.from({ length: n }, () => connectedTab());
    return { pane: tabsState.center.focus, tabs };
  }

  it("goes by the same trip, the tab it shows first, the rest once the new window listens", async () => {
    const { pane: p, tabs } = pane(3);
    splitTabOff(connectedTab(), p, "right");
    const { flow, cleanup } = harness();
    api.detachCommit.mockImplementation(async () => (calls.push("commit"), "win-7"));
    const moving = flow.movePane(p);
    await settled();
    // The new window has not said it takes tabs yet: the second tab waits.
    expect(api.detachBegin).toHaveBeenCalledTimes(1);
    expect(flow.detaching).not.toBeNull();
    flow.heardWindows([{ label: "win-7", title: "x", tabs: 1 }]);
    await moving;
    expect(api.detachBegin).toHaveBeenCalledTimes(3);
    const seats = api.detachCommit.mock.calls.map(([, p]) => JSON.parse(p as string).seat);
    expect(seats[0]).toEqual({ lead: null, before: false });
    expect(seats.slice(1).every((s) => s.lead !== null)).toBe(true);
    expect(api.detachCommit.mock.calls.slice(1).every(([, , o]) => (o as { target: string }).target === "win-7")).toBe(true);
    expect(flow.detaching).toBeNull();
    void tabs;
    cleanup();
  });

  it("does not start when any of it may not go, and names the tab", async () => {
    const { pane: p, tabs } = pane(2);
    splitTabOff(connectedTab(), p, "right");
    setTabStatus(tabs[1], "closed");
    const { flow, cleanup } = harness();
    await flow.movePane(p);
    expect(api.detachBegin).not.toHaveBeenCalled();
    expect(toasts.notifyInfo).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("a tab whose session ended meanwhile stops it, and what went is said", async () => {
    const { pane: p, tabs } = pane(2);
    splitTabOff(connectedTab(), p, "right");
    const { flow, cleanup } = harness();
    flow.heardWindows([{ label: "win-2", title: "x", tabs: 1 }]);
    api.detachCommit.mockImplementationOnce(async () => {
      for (const id of tabs) setTabStatus(id, "closed");
      return "win-2";
    });
    await flow.movePane(p, { window: "win-2" });
    expect(api.detachBegin).toHaveBeenCalledTimes(1);
    expect(toasts.notifyError).toHaveBeenCalledTimes(1);
    expect(String(toasts.notifyError.mock.calls[0][0])).not.toBe("");
    cleanup();
  });
});
