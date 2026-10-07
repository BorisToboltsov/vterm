import { describe, expect, it } from "vitest";
import { messages } from "./i18n/messages";
import {
  DETACH_BLOCK_MESSAGE,
  PACKET_VERSION,
  detachBlocker,
  detachErrorKey,
  detachOffered,
  ghostPlace,
  parsePacket,
  releasedOutside,
  type DetachState,
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

  it("an empty screen is still a terminal", () => {
    const empty = packet({ terminal: { cols: 80, rows: 24, data: "", commands: [] } });
    expect(parsePacket(JSON.stringify(empty))).not.toBeNull();
  });
});

const idle: DetachState = {
  mainWindow: true,
  tabs: 2,
  broadcast: false,
  connected: true,
  syncBusy: false,
  transfers: 0,
  chatBusy: false,
  editorBusy: false,
};

describe("detachBlocker", () => {
  it("an idle, connected tab can go", () => {
    expect(detachBlocker(idle)).toBeNull();
    // The main window keeps existing with no tabs, so its only tab can go too.
    expect(detachBlocker({ ...idle, tabs: 1 })).toBeNull();
  });

  it("not in synchronous-input mode", () => {
    expect(detachBlocker({ ...idle, broadcast: true })).toBe("broadcast");
  });

  it("not the only tab of a secondary window — that would reopen the same window", () => {
    expect(detachBlocker({ ...idle, mainWindow: false, tabs: 1 })).toBe("lastTab");
    expect(detachBlocker({ ...idle, mainWindow: false, tabs: 2 })).toBeNull();
  });

  it("only a connected tab has a session to take along", () => {
    expect(detachBlocker({ ...idle, connected: false })).toBe("notConnected");
  });

  it("work waiting in this window keeps the tab here", () => {
    expect(detachBlocker({ ...idle, syncBusy: true })).toBe("sync");
    expect(detachBlocker({ ...idle, transfers: 1 })).toBe("transfers");
    expect(detachBlocker({ ...idle, chatBusy: true })).toBe("ai");
    expect(detachBlocker({ ...idle, editorBusy: true })).toBe("editor");
  });

  it("names the reason that cannot be waited out first", () => {
    const everything: DetachState = {
      mainWindow: false,
      tabs: 1,
      broadcast: true,
      connected: false,
      syncBusy: true,
      transfers: 2,
      chatBusy: true,
      editorBusy: true,
    };
    expect(detachBlocker(everything)).toBe("broadcast");
    expect(detachBlocker({ ...everything, broadcast: false })).toBe("lastTab");
    expect(detachBlocker({ ...everything, broadcast: false, tabs: 2 })).toBe("notConnected");
    expect(detachBlocker({ ...everything, broadcast: false, tabs: 2, connected: true })).toBe(
      "sync",
    );
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
    expect(detachOffered({ mainWindow: true, tabs: 1, broadcast: false })).toBe(true);
    expect(detachOffered({ mainWindow: false, tabs: 2, broadcast: false })).toBe(true);
    expect(detachOffered({ mainWindow: false, tabs: 1, broadcast: false })).toBe(false);
    expect(detachOffered({ mainWindow: true, tabs: 3, broadcast: true })).toBe(false);
  });

  it("agrees with the blocker on the structural reasons", () => {
    for (const mainWindow of [true, false]) {
      for (const tabs of [1, 2]) {
        for (const broadcast of [true, false]) {
          const block = detachBlocker({ ...idle, mainWindow, tabs, broadcast });
          expect(detachOffered({ mainWindow, tabs, broadcast })).toBe(
            block !== "broadcast" && block !== "lastTab",
          );
        }
      }
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
    expect(detachErrorKey("handoff-failed: the new window did not take the tab over")).toBe(
      "window.detachFailed",
    );
    expect(detachErrorKey(new Error("open window: no display"))).toBe("window.detachFailed");
    expect(detachErrorKey(undefined)).toBe("window.detachFailed");
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
