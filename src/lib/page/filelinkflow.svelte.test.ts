import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  requestFilesDir: vi.fn(),
  revealPanel: vi.fn(),
  activateTab: vi.fn(),
  notifyInfo: vi.fn(),
  tabsState: { activeId: "a" as string | null },
}));
vi.mock("../stores/dockstate.svelte", () => ({ requestFilesDir: stores.requestFilesDir }));
vi.mock("../stores/layout.svelte", () => ({ revealPanel: stores.revealPanel }));
vi.mock("../stores/tabs.svelte", () => ({ activateTab: stores.activateTab, tabsState: stores.tabsState }));
vi.mock("../stores/toasts.svelte", () => ({ notifyInfo: stores.notifyInfo }));

import { createFileLinkFlow, type FileLinkFlow } from "./filelinkflow.svelte";
import { settings } from "../settings/settings.svelte";
import type { Tab } from "../stores/tabs.svelte";
import type { ServerProfile } from "../types";

const tab = (sessionId: string, over: Partial<Tab> = {}): Tab =>
  ({ sessionId, kind: "ssh", serverId: `srv-${sessionId}`, alias: sessionId, status: "Connected", gen: 0, ...over }) as Tab;

const file = (path: string, line?: number) => ({ kind: "file" as const, path, line });

function harness(tabs: Tab[], following: Record<string, boolean> = {}) {
  const state = $state({ tabs, following });
  const deps = {
    openFile: vi.fn(),
    openLocalFile: vi.fn(),
    enablePathSync: vi.fn((id: string) => {
      state.following[id] = true;
    }),
  };
  let flow!: FileLinkFlow;
  const cleanup = $effect.root(() => {
    flow = createFileLinkFlow({
      findTab: (id) => state.tabs.find((t) => t.sessionId === id),
      servers: () => [{ id: "srv-prod", alias: "db-01" } as ServerProfile],
      isProd: (id) => id === "prod",
      following: (id) => !!state.following[id],
      ...deps,
    });
  });
  flushSync();
  return { flow, state, ...deps, cleanup };
}

const modeBefore = settings.terminalFileLinks;
beforeEach(() => {
  vi.clearAllMocks();
  stores.tabsState.activeId = "a";
});
afterEach(() => {
  settings.terminalFileLinks = modeBefore;
});

describe("file link flow: a click", () => {
  it("opens at once when told to: a file on its line, through the editor's own way in", () => {
    settings.terminalFileLinks = "direct";
    const { flow, openFile, openLocalFile, cleanup } = harness([tab("a"), tab("l", { kind: "local" })]);
    flow.clicked("a", file("/etc/app.c", 42));
    flow.clicked("l", file("C:\\notes.txt"));
    expect(openFile.mock.calls).toEqual([["a", "/etc/app.c", { gotoLine: 42 }]]);
    expect(openLocalFile.mock.calls).toEqual([["l", "C:\\notes.txt", { gotoLine: undefined }]]);
    // The tab already on screen stays; the other is brought forward.
    expect(stores.activateTab.mock.calls).toEqual([["l"]]);
    expect(flow.ask).toBeNull();
    cleanup();
  });

  it("opens a folder in the session's file panel", () => {
    settings.terminalFileLinks = "direct";
    const { flow, openFile, cleanup } = harness([tab("a")]);
    flow.clicked("a", { kind: "dir", path: "/var/log" });
    expect(stores.requestFilesDir).toHaveBeenCalledWith("a", "/var/log");
    expect(stores.revealPanel).toHaveBeenCalledWith("files");
    expect(openFile).not.toHaveBeenCalled();
    cleanup();
  });

  it("asks first by default, naming the server and whether it is production", () => {
    settings.terminalFileLinks = "confirm";
    const { flow, openFile, cleanup } = harness([tab("prod", { serverId: "srv-prod" }), tab("l", { kind: "local" })]);
    flow.clicked("prod", file("/etc/nginx/nginx.conf"));
    expect(flow.ask).toEqual({
      kind: "open",
      sessionId: "prod",
      target: file("/etc/nginx/nginx.conf"),
      where: "db-01",
      prod: true,
    });
    expect(openFile).not.toHaveBeenCalled();
    flow.clicked("l", file("/tmp/x"));
    expect(flow.ask).toMatchObject({ sessionId: "l", where: null, prod: false });
    cleanup();
  });

  it("does nothing when switched off, and nothing for a tab that has gone", () => {
    settings.terminalFileLinks = "off";
    const { flow, openFile, cleanup } = harness([tab("a")]);
    flow.clicked("a", file("/etc/hosts"));
    flow.clicked("a", { kind: "unplaced" });
    settings.terminalFileLinks = "direct";
    flow.clicked("gone", file("/etc/hosts"));
    expect(flow.ask).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
    cleanup();
  });

  it("a name with no folder to read it in offers path sync, in any mode", () => {
    settings.terminalFileLinks = "direct";
    const { flow, cleanup } = harness([tab("a")]);
    flow.clicked("a", { kind: "unplaced" });
    expect(flow.ask).toEqual({ kind: "sync", sessionId: "a", where: "a", following: false });
    cleanup();
  });
});

describe("file link flow: the answer", () => {
  it("opens only what was asked about, and silences the question only when told", () => {
    settings.terminalFileLinks = "confirm";
    const { flow, openFile, cleanup } = harness([tab("a")]);
    flow.clicked("a", file("/etc/hosts", 3));
    flow.answer("open", false);
    expect(openFile.mock.calls).toEqual([["a", "/etc/hosts", { gotoLine: 3 }]]);
    expect(settings.terminalFileLinks).toBe("confirm");
    flow.clicked("a", file("/etc/fstab"));
    flow.answer("open", true);
    expect(settings.terminalFileLinks).toBe("direct");
    expect(openFile).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("cancel, a mismatched answer, or a tab gone since — nothing opens", () => {
    settings.terminalFileLinks = "confirm";
    const { flow, state, openFile, enablePathSync, cleanup } = harness([tab("a")]);
    flow.clicked("a", file("/etc/hosts"));
    flow.answer("cancel", true);
    flow.clicked("a", file("/etc/hosts"));
    flow.answer("sync", false);
    flow.clicked("a", file("/etc/hosts"));
    state.tabs = [];
    flow.answer("open", true);
    expect(openFile).not.toHaveBeenCalled();
    expect(enablePathSync).not.toHaveBeenCalled();
    expect(settings.terminalFileLinks).toBe("confirm");
    expect(flow.ask).toBeNull();
    cleanup();
  });

  it("'sync' turns path sync on through its own flow and says what comes next once it follows", () => {
    const { flow, enablePathSync, cleanup } = harness([tab("a")]);
    flow.clicked("a", { kind: "unplaced" });
    flow.answer("sync", false);
    expect(enablePathSync).toHaveBeenCalledWith("a");
    expect(stores.notifyInfo).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("no word while path sync waits on its own question", () => {
    const { flow, enablePathSync, cleanup } = harness([tab("a")]);
    enablePathSync.mockImplementation(() => {});
    flow.clicked("a", { kind: "unplaced" });
    flow.answer("sync", false);
    expect(stores.notifyInfo).not.toHaveBeenCalled();
    cleanup();
  });

  it("a closed tab takes its question with it, and only its own", () => {
    settings.terminalFileLinks = "confirm";
    const { flow, cleanup } = harness([tab("a"), tab("b")]);
    flow.clicked("a", file("/etc/hosts"));
    flow.forget("b");
    expect(flow.ask?.sessionId).toBe("a");
    flow.forget("a");
    expect(flow.ask).toBeNull();
    cleanup();
  });
});
