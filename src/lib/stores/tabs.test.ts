import { beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  closeTab,
  tabsForServer,
  dotClass,
  dropTab,
  findTab,
  focusPane,
  dockConnection,
  isLive,
  isMonitorable,
  joinPanes,
  localizedStatus,
  monitoredSessionId,
  moveTabTo,
  newTabAction,
  nextTabIndex,
  openTab,
  openLocalTab,
  reconnectTab,
  resetTabs,
  serverDots,
  setSplitRatio,
  setTabStatus,
  splitTabOff,
  statusLabel,
  tabsState,
} from "./tabs.svelte";
import { layoutProblems, panes } from "../splitlayout";
import { settings } from "../settings.svelte";

beforeEach(resetTabs);

/** Tabs per pane, in reading order. */
const shape = () => panes(tabsState.center).map((p) => p.tabs);
/** The store's two halves agree: the layout holds exactly the open tabs. */
const sound = () =>
  layoutProblems(
    tabsState.center,
    tabsState.list.map((t) => t.sessionId),
  );

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

  it("dockConnection tells connecting from a lost or failed session", () => {
    expect(dockConnection(statusLabel("connected"))).toBe("connected");
    expect(dockConnection(statusLabel("connecting"))).toBe("connecting");
    expect(dockConnection("connecting")).toBe("connecting");
    // A dropped session and a connect that never succeeded both leave the
    // panels without a session to run on.
    expect(dockConnection(statusLabel("closed"))).toBe("offline");
    expect(dockConnection(statusLabel("error", "timeout"))).toBe("offline");
    expect(dockConnection("")).toBe("offline");
  });

  it("isLive is true only while connected/connecting", () => {
    expect(isLive("Connected")).toBe(true);
    expect(isLive("Connecting…")).toBe(true);
    expect(isLive("Disconnected")).toBe(false);
    expect(isLive("Error: x")).toBe(false);
  });

  it("monitoredSessionId: the screensaver polls local tabs too, only while live", () => {
    // Regression: the card was SSH-only and said "no active sessions" on a local tab
    // whose status bar showed live metrics.
    expect(monitoredSessionId({ kind: "local", status: "Connected", sessionId: "l1" })).toBe("l1");
    expect(monitoredSessionId({ kind: "ssh", status: "Connected", sessionId: "s1" })).toBe("s1");
    expect(monitoredSessionId({ kind: "local", status: "Connecting…", sessionId: "l1" })).toBeNull();
    expect(monitoredSessionId({ kind: "ssh", status: "Disconnected", sessionId: "s1" })).toBeNull();
    expect(monitoredSessionId(null)).toBeNull();
    expect(monitoredSessionId(undefined)).toBeNull();
  });

  it("isMonitorable: connected SSH *and* local tabs (Phase 38), not connecting/closed", () => {
    // Local tabs now expose metrics too (native sysinfo collector).
    expect(isMonitorable({ kind: "local", status: "Connected" })).toBe(true);
    expect(isMonitorable({ kind: "ssh", status: "Connected" })).toBe(true);
    // Only a *live* session — connecting/closed/error don't qualify.
    expect(isMonitorable({ kind: "local", status: "Connecting…" })).toBe(false);
    expect(isMonitorable({ kind: "ssh", status: "Disconnected" })).toBe(false);
    expect(isMonitorable({ kind: "local", status: "Error: x" })).toBe(false);
    expect(isMonitorable(null)).toBe(false);
    expect(isMonitorable(undefined)).toBe(false);
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
    activateTab(b);
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

describe("the centre: panes and focus", () => {
  const open3 = () => [
    openTab("s", "A", null, false),
    openTab("s", "B", null, false),
    openTab("s", "C", null, false),
  ];

  it("the list keeps the order tabs were opened in; the strip order is the layout's", () => {
    const [a, b, c] = open3();
    moveTabTo(a, tabsState.center.focus, 2);
    expect(shape()).toEqual([[b, c, a]]);
    expect(tabsState.list.map((t) => t.sessionId)).toEqual([a, b, c]);
    // A reorder changes neither the shown tab nor anything else.
    expect(tabsState.activeId).toBe(c);
  });

  it("activeId is the tab shown by the pane in focus", () => {
    const [a, b, c] = open3();
    const left = tabsState.center.focus;
    splitTabOff(c, left, "right");
    expect(shape()).toEqual([[a, b], [c]]);
    expect(tabsState.activeId).toBe(c);
    // Focusing the other pane changes who is active without touching the tabs.
    focusPane(left);
    expect(tabsState.activeId).toBe(b);
    activateTab(a);
    expect(tabsState.activeId).toBe(a);
    expect(sound()).toEqual([]);
  });

  it("a new tab opens in the pane in focus", () => {
    const [a, b, c] = open3();
    splitTabOff(c, tabsState.center.focus, "right");
    const d = openLocalTab();
    expect(shape()).toEqual([[a, b], [c, d]]);
    expect(tabsState.activeId).toBe(d);
    activateTab(a);
    const e = openTab("s", "E", null, false);
    expect(shape()).toEqual([[a, b, e], [c, d]]);
    expect(sound()).toEqual([]);
  });

  it("a new tab can be opened straight into a new pane, in one step", () => {
    // What ⌘D does: the tab is opened and split off before anything is drawn,
    // so there is never an empty pane on screen.
    const [a, b, c] = open3();
    const anchor = tabsState.center.focus;
    const d = openLocalTab();
    splitTabOff(d, anchor, "bottom");
    expect(shape()).toEqual([[a, b, c], [d]]);
    expect(tabsState.activeId).toBe(d);
    expect(sound()).toEqual([]);
  });

  it("closing a pane's last tab removes the pane", () => {
    const [a, b, c] = open3();
    splitTabOff(c, tabsState.center.focus, "bottom");
    closeTab(c);
    expect(shape()).toEqual([[a, b]]);
    expect(tabsState.activeId).toBe(b);
    expect(sound()).toEqual([]);
  });

  it("joining brings every tab back to one pane", () => {
    const [a, b, c] = open3();
    const first = tabsState.center.focus;
    splitTabOff(a, first, "left");
    expect(shape()).toEqual([[a], [b, c]]);
    joinPanes();
    expect(shape()).toEqual([[a, b, c]]);
    expect(tabsState.activeId).toBe(a);
  });

  it("drops a dragged tab and resizes a split", () => {
    const [a, b, c] = open3();
    const first = tabsState.center.focus;
    dropTab(c, { kind: "pane", pane: first, zone: "right" });
    expect(shape()).toEqual([[a, b], [c]]);
    const root = tabsState.center.root;
    setSplitRatio(root.id, 0.3);
    const after = tabsState.center.root;
    expect(after.kind === "split" && after.ratio).toBe(0.3);
    dropTab(c, { kind: "strip", pane: first, index: 0 });
    expect(shape()).toEqual([[c, a, b]]);
  });

  it("closing an unknown tab changes nothing", () => {
    open3();
    const before = tabsState.center;
    closeTab("nope");
    expect(tabsState.center).toBe(before);
    expect(tabsState.list).toHaveLength(3);
  });
});

describe("tabsForServer", () => {
  it("names every session belonging to a server", () => {
    const a = openTab("s1", "A", null, false);
    openTab("s2", "B", null, false);
    const c = openTab("s1", "C", null, false);
    expect(tabsForServer("s1")).toEqual([a, c]);
    expect(tabsForServer("nobody")).toEqual([]);
  });

  it("closes nothing by itself", () => {
    // The point of returning ids rather than closing: the caller has to go
    // through the full teardown, which also drops the workspace, the chat and
    // the broadcast membership. A store-level bulk close could not do that
    // without inverting the store layering, so it used to leak all three.
    openTab("s1", "A", null, false);
    tabsForServer("s1");
    expect(tabsState.list).toHaveLength(1);
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
