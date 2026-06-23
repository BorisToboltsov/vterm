import { beforeEach, describe, expect, it } from "vitest";
import {
  closeTab,
  closeTabsForServer,
  dotClass,
  findTab,
  isLive,
  moveTab,
  nextTabIndex,
  openTab,
  openLocalTab,
  reconnectTab,
  setTabStatus,
  statusLabel,
  tabsState,
} from "./tabs.svelte";

beforeEach(() => {
  tabsState.list = [];
  tabsState.activeId = null;
});

describe("pure helpers", () => {
  it("statusLabel maps raw status", () => {
    expect(statusLabel("connecting")).toBe("Connecting…");
    expect(statusLabel("connected")).toBe("Connected");
    expect(statusLabel("closed")).toBe("Disconnected");
    expect(statusLabel("error", "auth-rejected")).toBe("Error: auth-rejected");
    expect(statusLabel("error")).toBe("Error: unknown");
  });

  it("dotClass picks a colour from a label", () => {
    expect(dotClass("Connected")).toBe("bg-green-500");
    expect(dotClass("Connecting…")).toBe("bg-yellow-500");
    expect(dotClass("Error: x")).toBe("bg-danger");
    expect(dotClass("Disconnected")).toBe("bg-muted");
  });

  it("isLive is true only while connected/connecting", () => {
    expect(isLive("Connected")).toBe(true);
    expect(isLive("Connecting…")).toBe(true);
    expect(isLive("Disconnected")).toBe(false);
    expect(isLive("Error: x")).toBe(false);
  });
});

describe("openTab / closeTab", () => {
  it("appends a tab and makes it active", () => {
    const id = openTab("srv1", "Web", null, false);
    expect(tabsState.list).toHaveLength(1);
    expect(tabsState.activeId).toBe(id);
    expect(findTab(id)?.status).toBe("connecting");
    expect(findTab(id)?.kind).toBe("ssh");
  });

  it("openLocalTab adds an active local tab with no server", () => {
    const id = openLocalTab();
    const tab = findTab(id);
    expect(tabsState.activeId).toBe(id);
    expect(tab?.kind).toBe("local");
    expect(tab?.serverId).toBe("");
    expect(tab?.alias).toBe("Local shell");
    expect(tab?.status).toBe("connecting");
  });

  it("focuses the neighbour after closing the active tab", () => {
    const a = openTab("s", "A", null, false);
    const b = openTab("s", "B", null, false);
    const c = openTab("s", "C", null, false);
    tabsState.activeId = b;
    closeTab(b);
    // Slot b is taken by c.
    expect(tabsState.activeId).toBe(c);
    expect(tabsState.list.map((t) => t.sessionId)).toEqual([a, c]);
  });

  it("clears active when the last tab is closed", () => {
    const a = openTab("s", "A", null, false);
    closeTab(a);
    expect(tabsState.list).toHaveLength(0);
    expect(tabsState.activeId).toBeNull();
  });
});

describe("setTabStatus / reconnectTab", () => {
  it("updates a tab's status label", () => {
    const id = openTab("s", "A", null, false);
    setTabStatus(id, "connected");
    expect(findTab(id)?.status).toBe("Connected");
  });

  it("reconnect bumps gen and shows connecting", () => {
    const id = openTab("s", "A", null, false);
    const gen0 = findTab(id)!.gen;
    reconnectTab(id);
    const tab = findTab(id)!;
    expect(tab.gen).toBe(gen0 + 1);
    expect(tab.status).toBe("Connecting…");
  });
});

describe("moveTab", () => {
  it("reorders the dragged tab to a new index", () => {
    const a = openTab("s", "A", null, false);
    const b = openTab("s", "B", null, false);
    const c = openTab("s", "C", null, false);
    moveTab(a, 2);
    expect(tabsState.list.map((t) => t.sessionId)).toEqual([b, c, a]);
  });
  it("ignores out-of-range / no-op moves", () => {
    const a = openTab("s", "A", null, false);
    const b = openTab("s", "B", null, false);
    moveTab(a, 0);
    moveTab(a, 9);
    expect(tabsState.list.map((t) => t.sessionId)).toEqual([a, b]);
  });
});

describe("closeTabsForServer", () => {
  it("removes every tab for a server", () => {
    openTab("s1", "A", null, false);
    openTab("s2", "B", null, false);
    openTab("s1", "C", null, false);
    closeTabsForServer("s1");
    expect(tabsState.list.map((t) => t.serverId)).toEqual(["s2"]);
  });
});

describe("nextTabIndex", () => {
  it("wraps with arrows", () => {
    expect(nextTabIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextTabIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextTabIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(nextTabIndex(1, 3, "ArrowLeft")).toBe(0);
  });
  it("jumps to the ends with Home/End", () => {
    expect(nextTabIndex(2, 4, "Home")).toBe(0);
    expect(nextTabIndex(0, 4, "End")).toBe(3);
  });
  it("returns null for non-navigation keys or no tabs", () => {
    expect(nextTabIndex(0, 3, "Enter")).toBeNull();
    expect(nextTabIndex(0, 3, "a")).toBeNull();
    expect(nextTabIndex(0, 0, "ArrowRight")).toBeNull();
  });
});
