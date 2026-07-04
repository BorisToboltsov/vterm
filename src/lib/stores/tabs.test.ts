import { beforeEach, describe, expect, it } from "vitest";
import {
  closeTab,
  closeTabsForServer,
  dotClass,
  findTab,
  isLive,
  localizedStatus,
  moveTab,
  newTabAction,
  nextTabIndex,
  openTab,
  openLocalTab,
  reconnectTab,
  serverDots,
  setTabStatus,
  statusLabel,
  tabsState,
} from "./tabs.svelte";
import { settings } from "../settings.svelte";

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

  it("newTabAction opens the active server, else a local shell", () => {
    // On an SSH tab → a fresh tab of that same server.
    expect(newTabAction({ kind: "ssh", serverId: "srv-1" })).toEqual({
      kind: "ssh",
      serverId: "srv-1",
    });
    // On a local tab → another local shell.
    expect(newTabAction({ kind: "local", serverId: "" })).toEqual({ kind: "local" });
    // Nothing open → local shell.
    expect(newTabAction(null)).toEqual({ kind: "local" });
    expect(newTabAction(undefined)).toEqual({ kind: "local" });
  });

  it("dotClass picks a colour from a label", () => {
    expect(dotClass("Connected")).toBe("bg-green-500");
    expect(dotClass("Connecting…")).toBe("bg-yellow-500");
    expect(dotClass("Error: x")).toBe("bg-danger");
    expect(dotClass("Disconnected")).toBe("bg-muted");
  });

  it("serverDots keeps tab order (newest last) with a connecting pulse", () => {
    // Rendered in the order given (tab order), not reshuffled by severity.
    const { dots, extra } = serverDots(["Connected", "Connecting…"]);
    expect(dots.map((d) => d.cls)).toEqual([
      "bg-green-500 ring-1 ring-[#166534]",
      "bg-yellow-500 ring-1 ring-[#854d0e]",
    ]);
    // Only the connecting dot pulses.
    expect(dots.map((d) => d.pulse)).toEqual([false, true]);
    expect(extra).toBe(0);
  });

  it("serverDots appends a newly connected tab at the end of the stack", () => {
    // Two dropped (muted) tabs, then a new connected one → green stays last.
    const { dots } = serverDots(["Disconnected", "Disconnected", "Connected"]);
    expect(dots[2].cls).toContain("bg-green-500");
  });

  it("serverDots caps at 3 and reports the remainder", () => {
    const { dots, extra } = serverDots(["Connected", "Connected", "Connected", "Connected"]);
    expect(dots).toHaveLength(3);
    expect(extra).toBe(1);
  });

  it("serverDots picks shown dots severity-first so an error is never hidden by the cap", () => {
    // 3 connected + 1 error (newest); cap 3 → error must survive (an older
    // connected overflows), but the error stays in tab order → last.
    const { dots, extra } = serverDots([
      "Connected",
      "Connected",
      "Connected",
      "Error: dropped",
    ]);
    expect(dots.some((d) => d.cls.includes("bg-danger"))).toBe(true);
    expect(dots[dots.length - 1].cls).toContain("bg-danger");
    expect(dots).toHaveLength(3);
    expect(extra).toBe(1);
  });

  it("serverDots falls back to a muted, non-pulsing dot for other statuses", () => {
    const { dots } = serverDots(["Disconnected"]);
    expect(dots[0]).toEqual({ cls: "bg-muted ring-1 ring-[#3f3f5a]", pulse: false });
  });

  it("serverDots handles an empty list", () => {
    expect(serverDots([])).toEqual({ dots: [], extra: 0 });
  });

  it("isLive is true only while connected/connecting", () => {
    expect(isLive("Connected")).toBe(true);
    expect(isLive("Connecting…")).toBe(true);
    expect(isLive("Disconnected")).toBe(false);
    expect(isLive("Error: x")).toBe(false);
  });

  it("localizedStatus maps the canonical (English) status to the UI language", () => {
    settings.language = "en";
    expect(localizedStatus("Connected")).toBe("Connected");
    expect(localizedStatus("connecting")).toBe("Connecting…");
    expect(localizedStatus("Disconnected")).toBe("Disconnected");
    expect(localizedStatus("Error: auth-rejected")).toBe("Error: auth-rejected");
    expect(localizedStatus("Not connected")).toBe("Not connected");

    settings.language = "ru";
    expect(localizedStatus("Connected")).toBe("Подключено");
    expect(localizedStatus("Connecting…")).toBe("Подключение…");
    expect(localizedStatus("Error: boom")).toBe("Ошибка: boom");
    expect(localizedStatus("Not connected")).toBe("Нет подключения");
    settings.language = "en";
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
