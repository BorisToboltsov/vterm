import { beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  closeTab,
  connectTabWith,
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
  openRestored,
  reconnectTab,
  resetTabs,
  serverDots,
  setSplitRatio,
  setTabStatus,
  setWaiting,
  NOT_CONNECTED,
  splitTabOff,
  statusLabel,
  tabsState,
  tilePanes,
  untilePanes,
} from "./tabs.svelte";
import { layoutProblems, panes, savedLayout } from "../splitlayout";
import { savedTab, type SavedTab, type WaitReason } from "../tabrestore";
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

// ── Tabs of the previous launch (v1.6, ADR 0019) ─────────────────────────────

describe("tabs that come back from the previous launch", () => {
  /** What a window with tabs `a b | c` would have saved, then forgotten. */
  function saved(): { tabs: SavedTab[]; layout: unknown } {
    const a = openTab("srv", "A", "typed-secret", true);
    openLocalTab();
    const c = openTab("srv", "C", null, false);
    splitTabOff(c, tabsState.center.focus, "right");
    activateTab(a);
    const out = {
      tabs: tabsState.list.map(savedTab),
      layout: JSON.parse(JSON.stringify(savedLayout(tabsState.center))),
    };
    resetTabs();
    return out;
  }
  const all = (reason: WaitReason | null) => () => reason;

  it("stand where they stood, and wait", () => {
    const s = saved();
    const [a, b, c] = s.tabs.map((t) => t.id);
    openRestored(s.tabs, s.layout, all("manual"));
    expect(shape()).toEqual([[a, b], [c]]);
    expect(tabsState.activeId).toBe(a);
    expect(sound()).toEqual([]);
    for (const tab of tabsState.list) {
      expect(tab.waiting).toBe("manual");
      expect(tab.status).toBe(NOT_CONNECTED);
      expect(tab.secret).toBeNull();
      expect(tab.remember).toBe(false);
    }
  });

  it("a waiting tab is not a live session for anything that asks", () => {
    const s = saved();
    openRestored(s.tabs, s.layout, all("prod"));
    const tab = tabsState.list[0];
    expect(isLive(tab.status)).toBe(false);
    expect(isMonitorable(tab)).toBe(false);
    expect(dockConnection(tab.status)).toBe("offline");
    expect(dotClass(tab.status)).toBe("bg-muted");
    settings.language = "en";
    expect(localizedStatus(tab.status)).toBe("Not connected");
  });

  it("a tab that may open at once comes back as any new tab does", () => {
    const s = saved();
    openRestored(s.tabs, s.layout, (tab) => (tab.kind === "local" ? null : "checking"));
    const local = tabsState.list.find((t) => t.kind === "local");
    expect(local?.waiting).toBeUndefined();
    expect(local?.status).toBe("connecting");
    expect(tabsState.list.filter((t) => t.waiting === "checking")).toHaveLength(2);
  });

  it("a local tab is titled as a local tab, whatever was saved", () => {
    openRestored([{ id: "l1", kind: "local", serverId: "", alias: "" }], null, all("manual"));
    expect(findTab("l1")?.alias).toBe("Local shell");
  });

  it("a container tab keeps what it enters", () => {
    const attach = { kind: "pod" as const, name: "api-0", argv: ["kubectl", "exec", "-it", "api-0", "--", "sh"] };
    openRestored([{ id: "k1", kind: "ssh", serverId: "srv", alias: "A", attach }], null, all("attach"));
    expect(findTab("k1")?.attach).toEqual(attach);
  });

  it("opening its session is a reconnect: the wait ends, the terminal is mounted anew", () => {
    const s = saved();
    openRestored(s.tabs, s.layout, all("manual"));
    const id = s.tabs[0].id;
    reconnectTab(id);
    const tab = findTab(id);
    expect(tab?.waiting).toBeUndefined();
    expect(tab?.status).toBe("Connecting…");
    expect(tab?.gen).toBe(1);
    // The others go on waiting, and nothing moved.
    expect(tabsState.list.filter((t) => t.waiting)).toHaveLength(2);
    expect(shape()).toEqual([[s.tabs[0].id, s.tabs[1].id], [s.tabs[2].id]]);
  });

  it("a secret typed for it connects it where it stands", () => {
    const s = saved();
    openRestored(s.tabs, s.layout, all("secret"));
    const id = s.tabs[2].id;
    const before = shape();
    connectTabWith(id, "typed", true);
    const tab = findTab(id);
    expect(tab).toMatchObject({ secret: "typed", remember: true, status: "Connecting…", gen: 1 });
    expect(tab?.waiting).toBeUndefined();
    expect(shape()).toEqual(before);
    expect(tabsState.list).toHaveLength(3);
    connectTabWith("nobody", "x", false);
    expect(tabsState.list).toHaveLength(3);
  });

  it("the reason a tab waits can change, but only while it waits", () => {
    const s = saved();
    openRestored(s.tabs, s.layout, all("checking"));
    const [a, b] = s.tabs.map((t) => t.id);
    setWaiting(a, "secret");
    expect(findTab(a)?.waiting).toBe("secret");
    reconnectTab(b);
    setWaiting(b, "prod");
    expect(findTab(b)?.waiting).toBeUndefined();
    const list = tabsState.list;
    setWaiting(a, "secret");
    expect(tabsState.list).toBe(list);
  });

  it("tabs opened before the restore ran are kept and stay on screen", () => {
    const s = saved();
    const early = openLocalTab();
    openRestored(s.tabs, s.layout, all("manual"));
    expect(tabsState.list).toHaveLength(4);
    expect(tabsState.activeId).toBe(early);
    expect(sound()).toEqual([]);
    // Restoring again brings nothing twice.
    openRestored(s.tabs, s.layout, all("manual"));
    expect(tabsState.list).toHaveLength(4);
  });

  it("a saved layout that is junk still gives every tab a pane", () => {
    const s = saved();
    openRestored(s.tabs, { root: "nope", focus: 3 }, all("manual"));
    expect(shape()).toEqual([s.tabs.map((t) => t.id)]);
    expect(sound()).toEqual([]);
  });

  it("closing a waiting tab takes it out like any other", () => {
    const s = saved();
    openRestored(s.tabs, s.layout, all("manual"));
    closeTab(s.tabs[2].id);
    expect(shape()).toEqual([[s.tabs[0].id, s.tabs[1].id]]);
    expect(sound()).toEqual([]);
  });
});

// ── A grid of panes with one command, and the way back (v1.9, ADR 0022) ──────

describe("tiling tabs into a grid and coming back", () => {
  /** `[a b] | [c d]`, focus on the right pane showing `d`. */
  function fourInTwoPanes(): string[] {
    const ids = [openLocalTab(), openLocalTab(), openLocalTab(), openLocalTab()];
    const left = tabsState.center.focus;
    splitTabOff(ids[2], left, "right");
    moveTabTo(ids[3], tabsState.center.focus);
    return ids;
  }
  const shown = () => panes(tabsState.center).map((p) => p.active);

  it("gives each asked-for tab a pane of its own; the rest wait in the first", () => {
    const [a, b, c, d] = fourInTwoPanes();
    tilePanes([a, c, d], 2);
    expect(shown()).toEqual([a, c, d]);
    expect(shape()).toEqual([[a, b], [c], [d]]);
    expect(sound()).toEqual([]);
    expect(tabsState.tiled).toBe(true);
    // The tab in focus kept the focus.
    expect(tabsState.activeId).toBe(d);
  });

  it("coming back restores the layout as it was, and the tab in focus", () => {
    const [a, b, c, d] = fourInTwoPanes();
    const before = shape();
    tilePanes([a, b, c, d], 2);
    activateTab(b);
    untilePanes();
    expect(shape()).toEqual(before);
    expect(tabsState.activeId).toBe(b);
    expect(tabsState.tiled).toBe(false);
    expect(sound()).toEqual([]);
  });

  it("a second grid over the first still returns to the layout before both", () => {
    const [a, b, c, d] = fourInTwoPanes();
    const before = shape();
    tilePanes([a, b, c, d], 2);
    tilePanes([a, b], 2);
    untilePanes();
    expect(shape()).toEqual(before);
  });

  it("tabs closed meanwhile are left out, tabs opened meanwhile get a pane", () => {
    const [a, b, c, d] = fourInTwoPanes();
    tilePanes([a, b, c, d], 2);
    closeTab(c);
    const fresh = openLocalTab();
    untilePanes();
    expect(sound()).toEqual([]);
    const all = shape().flat();
    expect(all).not.toContain(c);
    expect(all).toContain(fresh);
    // What survived stands where it stood: `d` alone on the right, `a b` on the left.
    expect(shape().find((tabs) => tabs.includes(d))).not.toContain(a);
    expect(shape().find((tabs) => tabs.includes(a))).toContain(b);
  });

  it("with nothing remembered, coming back is all tabs in one pane", () => {
    const ids = fourInTwoPanes();
    expect(tabsState.tiled).toBe(false);
    untilePanes();
    expect(shape()).toEqual([ids]);
  });

  it("joining the panes by hand forgets the layout before the grid", () => {
    const [a, b, c, d] = fourInTwoPanes();
    tilePanes([a, b, c, d], 2);
    joinPanes();
    expect(tabsState.tiled).toBe(false);
    untilePanes();
    expect(panes(tabsState.center)).toHaveLength(1);
  });

  it("a grid that changes nothing remembers nothing", () => {
    fourInTwoPanes();
    tilePanes(["nobody"], 2);
    expect(tabsState.tiled).toBe(false);
  });

  it("closing everything forgets the grid", () => {
    const ids = fourInTwoPanes();
    tilePanes(ids, 2);
    resetTabs();
    expect(tabsState.tiled).toBe(false);
  });
});
