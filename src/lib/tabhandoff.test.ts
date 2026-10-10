import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { messages } from "./i18n/messages";
import { addTabBehind, emptyLayout, panes, placeTab, type CenterLayout } from "./splitlayout";
import {
  DETACH_BLOCK_MESSAGE,
  PACKET_VERSION,
  detachBlocker,
  detachErrorKey,
  detachOffered,
  ghostPlace,
  moveOffered,
  paneDetachOffered,
  paneMoveBlocker,
  paneMoveOffered,
  paneMoveOrder,
  parsePacket,
  releasedOutside,
  type DetachState,
  type PaneStep,
  type TabPacket,
} from "./tabhandoff";

const packet = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PACKET_VERSION,
  tab: {
    sessionId: "s1",
    kind: "ssh",
    serverId: "srv",
    alias: "web",
    secret: "hunter2",
    remember: false,
    status: "Connected",
    gen: 3,
  },
  seat: null,
  terminal: { cols: 120, rows: 40, data: "\u001b[1mhi\u001b[0m", commands: ["ls"] },
  workspace: null,
  chat: null,
  dock: null,
  sync: null,
  page: {
    terminalCwd: "/srv",
    followTerminal: true,
    followSeen: "/srv",
    localShell: null,
    shellIntegrated: false,
    recording: null,
    recordingPaused: false,
  },
  ...over,
});

describe("parsePacket", () => {
  it("reads back what a window sent", () => {
    const sent = packet();
    const got = parsePacket(JSON.stringify(sent)) as TabPacket;
    expect(got).toEqual(sent);
    // The typed secret travels with the tab — it is what a reconnect reuses.
    expect(got.tab.secret).toBe("hunter2");
  });

  it("nothing to read is not a packet", () => {
    expect(parsePacket(null)).toBeNull();
    expect(parsePacket("")).toBeNull();
    expect(parsePacket("{not json")).toBeNull();
    expect(parsePacket("[]")).toBeNull();
    expect(parsePacket('"text"')).toBeNull();
  });

  it("refuses another version rather than guessing at its shape", () => {
    expect(parsePacket(JSON.stringify(packet({ v: PACKET_VERSION + 1 })))).toBeNull();
    expect(parsePacket(JSON.stringify(packet({ v: undefined })))).toBeNull();
  });

  it("refuses a packet the window could not show a tab from", () => {
    const bad = (over: Record<string, unknown>) => parsePacket(JSON.stringify(packet(over)));
    expect(bad({ tab: null })).toBeNull();
    expect(bad({ tab: { sessionId: "", kind: "ssh" } })).toBeNull();
    expect(bad({ tab: { sessionId: "s1", kind: "telnet" } })).toBeNull();
    expect(bad({ terminal: null })).toBeNull();
    expect(bad({ terminal: { cols: 80, rows: 24, data: 5, commands: [] } })).toBeNull();
    // A grid of zero columns cannot be replayed.
    expect(bad({ terminal: { cols: 0, rows: 24, data: "", commands: [] } })).toBeNull();
    expect(bad({ terminal: { cols: 80, rows: 2.5, data: "", commands: [] } })).toBeNull();
    expect(bad({ terminal: { cols: 80, rows: 24, data: "", commands: "ls" } })).toBeNull();
    expect(bad({ page: null })).toBeNull();
  });

  it("reads the seat of a tab that travels with its pane", () => {
    const read = (seat: unknown) => parsePacket(JSON.stringify(packet({ seat })));
    expect(read({ lead: null, before: false })?.seat).toEqual({ lead: null, before: false });
    expect(read({ lead: "s0", before: true })?.seat).toEqual({ lead: "s0", before: true });
    // A seat the window could not act on is a packet of another shape.
    expect(read(undefined)).toBeNull();
    expect(read("first")).toBeNull();
    expect(read({ lead: "", before: false })).toBeNull();
    expect(read({ lead: 5, before: false })).toBeNull();
    expect(read({ lead: "s0" })).toBeNull();
  });

  it("an empty screen is still a terminal", () => {
    const empty = packet({ terminal: { cols: 80, rows: 24, data: "", commands: [] } });
    expect(parsePacket(JSON.stringify(empty))).not.toBeNull();
  });
});

const idle: DetachState = {
  mainWindow: true,
  tabs: 2,
  connected: true,
  syncBusy: false,
  chatBusy: false,
  editorBusy: false,
};

describe("detachBlocker", () => {
  it("an idle, connected tab can go", () => {
    expect(detachBlocker(idle)).toBeNull();
    // The main window keeps existing with no tabs, so its only tab can go too.
    expect(detachBlocker({ ...idle, tabs: 1 })).toBeNull();
  });

  it("a member of the synchronous-input group goes like any other tab", () => {
    // The group has no layout of its own since v1.9: its members stand in panes.
    expect("broadcast" in idle).toBe(false);
  });

  it("not the only tab of a secondary window — that would reopen the same window", () => {
    expect(detachBlocker({ ...idle, mainWindow: false, tabs: 1 })).toBe("lastTab");
    expect(detachBlocker({ ...idle, mainWindow: false, tabs: 2 })).toBeNull();
  });

  it("into a window that is already open the only tab may go — that is how it returns", () => {
    expect(detachBlocker({ ...idle, mainWindow: false, tabs: 1 }, true)).toBeNull();
    // Everything else holds for an open window as for a new one.
    expect(detachBlocker({ ...idle, connected: false }, true)).toBe("notConnected");
    expect(detachBlocker({ ...idle, syncBusy: true }, true)).toBe("sync");
  });

  it("only a connected tab has a session to take along", () => {
    expect(detachBlocker({ ...idle, connected: false })).toBe("notConnected");
  });

  it("work waiting in this window keeps the tab here", () => {
    expect(detachBlocker({ ...idle, syncBusy: true })).toBe("sync");
    expect(detachBlocker({ ...idle, chatBusy: true })).toBe("ai");
    expect(detachBlocker({ ...idle, editorBusy: true })).toBe("editor");
  });

  it("a file transfer under way is no reason at all", () => {
    // A transfer is a job of the backend (v1.12, ADR 0025), told to whichever
    // window shows the tab: nothing of it waits here, so nothing of it is asked
    // about. `DetachState` has no field for it — and must not grow one back.
    const fields: Record<keyof DetachState, true> = {
      mainWindow: true,
      tabs: true,
      connected: true,
      syncBusy: true,
      chatBusy: true,
      editorBusy: true,
    };
    expect(Object.keys(fields).sort()).toEqual(
      ["chatBusy", "connected", "editorBusy", "mainWindow", "syncBusy", "tabs"],
    );
    expect(Object.keys(DETACH_BLOCK_MESSAGE)).not.toContain("transfers");
  });

  it("names the reason that cannot be waited out first", () => {
    const everything: DetachState = {
      mainWindow: false,
      tabs: 1,
      connected: false,
      syncBusy: true,
      chatBusy: true,
      editorBusy: true,
    };
    expect(detachBlocker(everything)).toBe("lastTab");
    expect(detachBlocker({ ...everything, tabs: 2 })).toBe("notConnected");
    expect(detachBlocker({ ...everything, tabs: 2, connected: true })).toBe("sync");
  });

  it("every reason has a message in every language", () => {
    for (const key of Object.values(DETACH_BLOCK_MESSAGE)) {
      for (const dict of Object.values(messages)) {
        expect(dict[key], key).toBeTruthy();
      }
    }
  });
});

describe("detachOffered", () => {
  it("the command is hidden where no tab could ever go", () => {
    expect(detachOffered({ mainWindow: true, tabs: 1 })).toBe(true);
    expect(detachOffered({ mainWindow: false, tabs: 2 })).toBe(true);
    expect(detachOffered({ mainWindow: false, tabs: 1 })).toBe(false);
  });

  it("agrees with the blocker on the structural reason", () => {
    for (const mainWindow of [true, false]) {
      for (const tabs of [1, 2]) {
        const block = detachBlocker({ ...idle, mainWindow, tabs });
        expect(detachOffered({ mainWindow, tabs })).toBe(block !== "lastTab");
      }
    }
  });
});

describe("moveOffered", () => {
  it("needs another window to move to", () => {
    expect(moveOffered(0)).toBe(false);
    expect(moveOffered(1)).toBe(true);
    expect(moveOffered(3)).toBe(true);
  });

  it("agrees with the blocker: what is offered is not structurally blocked", () => {
    for (const mainWindow of [true, false]) {
      for (const tabs of [1, 2]) {
        expect(detachBlocker({ ...idle, mainWindow, tabs }, true)).toBeNull();
      }
    }
  });
});

// ── A whole pane (v1.10) ─────────────────────────────────────────────────────

/** What a window ends up with after taking the steps in order, as the page applies them. */
function arrive(start: CenterLayout, steps: readonly PaneStep[]): CenterLayout {
  return steps.reduce(
    (l, { tab, seat }) =>
      seat.lead === null
        ? placeTab(l, tab, null)
        : addTabBehind(l, tab, seat.lead, seat.before ? "before" : "end"),
    start,
  );
}

describe("paneMoveOrder", () => {
  it("the tab the pane shows goes first, the others take their seats around it", () => {
    expect(paneMoveOrder(["a", "b", "c", "d"], "c")).toEqual([
      { tab: "c", seat: { lead: null, before: false } },
      { tab: "a", seat: { lead: "c", before: true } },
      { tab: "b", seat: { lead: "c", before: true } },
      { tab: "d", seat: { lead: "c", before: false } },
    ]);
  });

  it("a pane that shows a file of another pane's session is led by its first tab", () => {
    expect(paneMoveOrder(["a", "b"], "elsewhere").map((s) => s.tab)).toEqual(["a", "b"]);
    expect(paneMoveOrder(["a", "b"], null)[0]).toEqual({
      tab: "a",
      seat: { lead: null, before: false },
    });
  });

  it("nothing to move is no steps; one tab is only its own lead", () => {
    expect(paneMoveOrder([], "a")).toEqual([]);
    expect(paneMoveOrder(["a"], "a")).toEqual([{ tab: "a", seat: { lead: null, before: false } }]);
  });

  it("taken in order, the seats rebuild the pane: same strip, same tab shown", () => {
    const TABS = fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e", "f"), { minLength: 1 });
    fc.assert(
      fc.property(TABS, fc.nat(), fc.boolean(), (tabs, pick, intoOpen) => {
        const shown = tabs[pick % tabs.length];
        const steps = paneMoveOrder(tabs, shown);
        // Every tab goes exactly once, and only the first one opens the pane.
        expect(steps.map((s) => s.tab).sort()).toEqual([...tabs].sort());
        expect(steps.filter((s) => s.seat.lead === null).map((s) => s.tab)).toEqual([shown]);
        // A window opened for the pane, or one that already shows tabs of its own.
        const start = intoOpen ? placeTab(placeTab(emptyLayout(), "x", null), "y", null) : emptyLayout();
        const pane = panes(arrive(start, steps))[0];
        expect(pane.tabs).toEqual(intoOpen ? ["x", "y", ...tabs] : tabs);
        expect(pane.active).toBe(shown);
      }),
      { numRuns: 300 },
    );
  });
});

describe("a pane offered as a whole", () => {
  it("only when it is more than one session tab — one is that tab's own move", () => {
    expect(paneMoveOffered(0)).toBe(false);
    expect(paneMoveOffered(1)).toBe(false);
    expect(paneMoveOffered(2)).toBe(true);
  });

  it("to a new window — unless it is every tab of a secondary window", () => {
    expect(paneDetachOffered({ mainWindow: true, tabs: 3 }, 3)).toBe(true);
    expect(paneDetachOffered({ mainWindow: false, tabs: 3 }, 2)).toBe(true);
    expect(paneDetachOffered({ mainWindow: false, tabs: 3 }, 3)).toBe(false);
  });
});

describe("paneMoveBlocker", () => {
  const idle: DetachState = {
    mainWindow: true,
    tabs: 4,
    connected: true,
    syncBusy: false,
  chatBusy: false,
    editorBusy: false,
  };

  it("a pane of idle, connected tabs can go", () => {
    expect(paneMoveBlocker([idle, idle, idle], false)).toBeNull();
    expect(paneMoveBlocker([idle, idle], true)).toBeNull();
    expect(paneMoveBlocker([], false)).toBeNull();
  });

  it("one tab that cannot go keeps the whole pane, and is named", () => {
    expect(paneMoveBlocker([idle, { ...idle, syncBusy: true }, idle], true)).toEqual({
      at: 1,
      block: "sync",
    });
    expect(paneMoveBlocker([idle, idle, { ...idle, connected: false }], false)).toEqual({
      at: 2,
      block: "notConnected",
    });
    // The first one in strip order, when several cannot.
    expect(
      paneMoveBlocker([{ ...idle, chatBusy: true }, { ...idle, syncBusy: true }], true),
    ).toEqual({ at: 0, block: "ai" });
  });

  it("every tab of a secondary window: not to a new one, but into an open one", () => {
    const second = { ...idle, mainWindow: false, tabs: 2 };
    expect(paneMoveBlocker([second, second], false)).toEqual({ at: 0, block: "lastTab" });
    expect(paneMoveBlocker([second, second], true)).toBeNull();
    // Part of its tabs may go anywhere: the window keeps the rest.
    const third = { ...second, tabs: 3 };
    expect(paneMoveBlocker([third, third], false)).toBeNull();
  });

  it("a tab is judged by the rule of an open window: the pane's own question is asked once", () => {
    // Alone, the last-but-one tab of a secondary window could not open a new
    // window once its neighbour has gone; as part of the pane it is not asked.
    const second = { ...idle, mainWindow: false, tabs: 3 };
    expect(paneMoveBlocker([second, second], false)).toBeNull();
  });

  it("agrees with what is offered: an offered pane is never structurally blocked", () => {
    for (const mainWindow of [true, false]) {
      for (let tabs = 1; tabs <= 4; tabs += 1) {
        for (let inPane = 1; inPane <= tabs; inPane += 1) {
          const s = { ...idle, mainWindow, tabs };
          const states = Array.from({ length: inPane }, () => s);
          expect(paneMoveBlocker(states, false)?.block === "lastTab").toBe(
            !paneDetachOffered(s, inPane),
          );
        }
      }
    }
  });
});

describe("the pane's messages", () => {
  it("are there in every language, with the same placeholders", () => {
    for (const lang of Object.keys(messages) as (keyof typeof messages)[]) {
      const dict = messages[lang] as Record<string, string>;
      expect(dict["window.paneBlocked"]).toContain("{tab}");
      expect(dict["window.paneBlocked"]).toContain("{reason}");
      expect(dict["window.paneMovedPartly"]).toContain("{moved}");
      expect(dict["window.paneMovedPartly"]).toContain("{total}");
      expect(dict["palette.movePaneTo"]).toContain("{target}");
    }
  });
});

describe("detachErrorKey", () => {
  it("a terminal printing too fast is its own message — the remedy is to wait", () => {
    expect(
      detachErrorKey("handoff-overflow: the terminal is printing too fast to move it now"),
    ).toBe("window.detachOverflow");
  });

  it("anything else is a window that did not take the tab", () => {
    expect(detachErrorKey("handoff-failed: the other window did not take the tab over")).toBe(
      "window.detachFailed",
    );
    expect(detachErrorKey(new Error("open window: no display"))).toBe("window.detachFailed");
    expect(detachErrorKey(undefined)).toBe("window.detachFailed");
  });

  it("an open window that did not take the tab is not a window that failed to open", () => {
    expect(detachErrorKey("handoff-failed: the other window did not take the tab over", true)).toBe(
      "window.moveFailed",
    );
    // Too much output is the same remedy wherever the tab was going.
    expect(detachErrorKey("handoff-overflow: …", true)).toBe("window.detachOverflow");
    for (const dict of Object.values(messages)) expect(dict["window.moveFailed"]).toBeTruthy();
  });
});

describe("releasedOutside", () => {
  const viewport = { width: 1000, height: 600 };

  it("inside the window, edges included, is an ordinary drop", () => {
    expect(releasedOutside(500, 300, viewport)).toBe(false);
    expect(releasedOutside(0, 0, viewport)).toBe(false);
    expect(releasedOutside(999, 599, viewport)).toBe(false);
  });

  it("past any edge is outside", () => {
    expect(releasedOutside(-1, 300, viewport)).toBe(true);
    expect(releasedOutside(500, -1, viewport)).toBe(true);
    expect(releasedOutside(1000, 300, viewport)).toBe(true);
    expect(releasedOutside(500, 600, viewport)).toBe(true);
  });
});

describe("ghostPlace", () => {
  const viewport = { width: 1000, height: 600 };

  it("inside the window the label hangs from the pointer", () => {
    expect(ghostPlace({ x: 400, y: 200, outside: false }, viewport)).toEqual({ x: 412, y: 208 });
    // Near the edge it is left alone too — it is still under the pointer.
    expect(ghostPlace({ x: 990, y: 590, outside: false }, viewport)).toEqual({ x: 1002, y: 598 });
  });

  it("outside it waits at the edge the pointer left through, fully in sight", () => {
    expect(ghostPlace({ x: 1400, y: 200, outside: true }, viewport)).toEqual({ x: 732, y: 208 });
    expect(ghostPlace({ x: -300, y: 200, outside: true }, viewport)).toEqual({ x: 8, y: 208 });
    expect(ghostPlace({ x: 400, y: -80, outside: true }, viewport)).toEqual({ x: 412, y: 8 });
    expect(ghostPlace({ x: 400, y: 900, outside: true }, viewport)).toEqual({ x: 412, y: 556 });
  });

  it("a window narrower than the label keeps it at the margin", () => {
    expect(ghostPlace({ x: 500, y: 50, outside: true }, { width: 200, height: 30 })).toEqual({
      x: 8,
      y: 8,
    });
  });
});
