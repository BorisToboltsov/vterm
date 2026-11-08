import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keeper = vi.hoisted(() => ({
  takeSavedTabs: vi.fn((): { main: unknown; others: { label: string; raw: unknown }[] } | null => null),
  startSavingTabs: vi.fn(),
}));
vi.mock("../stores/tabrestore.svelte", () => keeper);
const api = vi.hoisted(() => ({
  connectPlan: vi.fn(async (_id: string) => ({ needsSecret: false, secretLabel: "Password" })),
  tabContentLoad: vi.fn(async (_id: string): Promise<string | null> => null),
  tabContentSave: vi.fn(async (_id: string, _content: string) => {}),
  tabContentForget: vi.fn(async (_ids: string[]) => {}),
  tabContentKeepOnly: vi.fn(async (_ids: string[]) => {}),
  reopenWindows: vi.fn(async (_w: { label: string; record: string }[], _bg: string | null): Promise<string[]> => []),
  takeRestore: vi.fn(async (): Promise<string | null> => null),
  sftpReadText: vi.fn(),
  readLocalText: vi.fn(),
  sftpWriteAccess: vi.fn(async () => "writable"),
  writeToTerminal: vi.fn(async (_sid: string, _data: Uint8Array) => {}),
}));
vi.mock("../api", () => api);
const toasts = vi.hoisted(() => ({ notifyInfo: vi.fn(), notifyError: vi.fn() }));
vi.mock("../stores/toasts.svelte", () => toasts);

import { createRestoreFlow, type RestoreFlow } from "./restoreflow.svelte";
import { settings } from "../settings/settings.svelte";
import { addTab, emptyLayout } from "../layout/splitlayout";
import { findTab, NOT_CONNECTED, resetTabs, tabsState, type Tab } from "../stores/tabs.svelte";
import { savedWindow, type TabFacts } from "../tabs/tabrestore";
import { contentRecord } from "../tabs/tabcontent";
import { getWorkspace, workspacesState } from "../stores/workspaces.svelte";
import { peekDockState, resetDockState } from "../stores/dockstate.svelte";
import { getChat, peekChat, removeChat } from "../stores/aichat.svelte";
import type { TermSnapshot } from "../windows/tabhandoff";
import type { ServerProfile } from "../types";

const tab = (sessionId: string, over: Partial<Tab> = {}): Tab => ({
  sessionId,
  kind: "ssh",
  serverId: `srv-${sessionId}`,
  alias: sessionId,
  secret: null,
  remember: false,
  status: "Connected",
  gen: 0,
  ...over,
});

const ATTACH = { kind: "container" as const, name: "nginx", argv: ["docker", "exec", "-it", "nginx", "sh"] };

/** A slot as the window wrote it, after the trip through JSON. */
const slot = (tabs: Tab[], factsOf?: (id: string) => TabFacts): unknown => {
  let layout = emptyLayout();
  for (const t of tabs) layout = addTab(layout, t.sessionId);
  return JSON.parse(JSON.stringify(savedWindow(tabs, layout, factsOf)));
};

const server = (id: string, over: Partial<ServerProfile> = {}): ServerProfile =>
  ({ id, alias: `alias-${id}`, prod: false, ...over }) as ServerProfile;

/** Let the keychain answers (connectPlan) arrive. */
const settled = () => new Promise((r) => setTimeout(r, 0));

const SNAPSHOT: TermSnapshot = { cols: 80, rows: 24, data: "$ make\r\nok\r\n", commands: ["make"], lines: 26, fileBlocks: [] };

function harness(servers: ServerProfile[]) {
  const askSecret = vi.fn();
  const keepsake = vi.fn(async (_sid: string): Promise<TermSnapshot | null> => SNAPSHOT);
  let flow!: RestoreFlow;
  const cleanup = $effect.root(() => {
    flow = createRestoreFlow({ servers: () => servers, askSecret, keepsake, background: () => "#101010" });
  });
  flushSync();
  return { flow, askSecret, keepsake, cleanup };
}

const status = (id: string) => {
  const t = findTab(id);
  return t ? { waiting: t.waiting ?? null, status: t.status, gen: t.gen } : null;
};

const modeBefore = settings.restoreTabs;
const outputBefore = settings.restoreOutput;
beforeEach(() => {
  vi.clearAllMocks();
  resetTabs();
  workspacesState.map = {};
  resetDockState();
  keeper.takeSavedTabs.mockReturnValue(null);
  api.reopenWindows.mockResolvedValue([]);
  api.takeRestore.mockResolvedValue(null);
  api.tabContentLoad.mockResolvedValue(null);
});
afterEach(() => {
  settings.restoreTabs = modeBefore;
  settings.restoreOutput = outputBefore;
  for (const t of tabsState.list) removeChat(t.sessionId);
  resetTabs();
});

describe("restore flow: bringing the tabs back", () => {
  it("with nothing saved it opens nothing, and the slot starts being written", async () => {
    const { flow, cleanup } = harness([]);
    await flow.restore();
    expect(tabsState.list).toEqual([]);
    expect(keeper.startSavingTabs).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("'by hand' brings every tab back waiting, connects nothing, and names the servers gone", async () => {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a"), tab("gone"), tab("l", { kind: "local" })]), others: [] });
    const { flow, cleanup } = harness([server("srv-a")]);
    await flow.restore();
    expect(status("a")).toEqual({ waiting: "manual", status: NOT_CONNECTED, gen: 0 });
    expect(status("l")).toEqual({ waiting: "manual", status: NOT_CONNECTED, gen: 0 });
    expect(status("gone")).toBeNull();
    expect(toasts.notifyInfo).toHaveBeenCalledTimes(1);
    expect(api.connectPlan).not.toHaveBeenCalled();
    cleanup();
  });

  it("'connect' opens only what the policy allows: a local shell and a server that asks nothing", async () => {
    settings.restoreTabs = "connect";
    keeper.takeSavedTabs.mockReturnValue({
      main: slot([
        tab("l", { kind: "local" }),
        tab("web"),
        tab("pw"),
        tab("prod"),
        tab("box", { attach: ATTACH }),
      ]),
      others: [],
    });
    // The keychain answers when the test lets it: until then the server is being checked.
    let answer!: () => void;
    const asked = new Promise<void>((r) => (answer = r));
    api.connectPlan.mockImplementation(async (id: string) => {
      await asked;
      return { needsSecret: id === "srv-pw", secretLabel: "Password" };
    });
    const { flow, cleanup } = harness([
      server("srv-web"),
      server("srv-pw"),
      server("srv-prod", { prod: true }),
      server("srv-box"),
    ]);
    await flow.restore();
    // A local shell connects as it mounts; a server is asked whether it wants a secret first.
    expect(status("l")).toEqual({ waiting: null, status: "connecting", gen: 0 });
    expect(status("web")?.waiting).toBe("checking");
    expect(status("prod")?.waiting).toBe("prod");
    expect(status("box")?.waiting).toBe("attach");
    answer();
    await settled();
    expect(status("web")).toEqual({ waiting: null, status: "Connecting…", gen: 1 });
    expect(status("pw")?.waiting).toBe("secret");
    // A production server and a container are never asked about, let alone dialled.
    expect(api.connectPlan.mock.calls.map(([id]) => id).sort()).toEqual(["srv-pw", "srv-web"]);
    cleanup();
  });

  it("a server whose keychain could not be asked waits for its button", async () => {
    settings.restoreTabs = "connect";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("web")]), others: [] });
    api.connectPlan.mockRejectedValueOnce(new Error("no keychain"));
    const { flow, cleanup } = harness([server("srv-web")]);
    await flow.restore();
    await settled();
    expect(status("web")?.waiting).toBe("manual");
    cleanup();
  });

  it("runs once, and starts writing the slot even when the restore throws", async () => {
    keeper.takeSavedTabs.mockImplementationOnce(() => {
      throw new Error("bad storage");
    });
    const { flow, cleanup } = harness([]);
    await expect(flow.restore()).rejects.toThrow("bad storage");
    expect(keeper.startSavingTabs).toHaveBeenCalledTimes(1);
    await flow.restore();
    expect(keeper.takeSavedTabs).toHaveBeenCalledTimes(1);
    expect(keeper.startSavingTabs).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("restore flow: opening a waiting tab", () => {
  async function restoredManually(tabs: Tab[], servers: ServerProfile[]) {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot(tabs), others: [] });
    const h = harness(servers);
    await h.flow.restore();
    return h;
  }

  it("its button connects it in place, asking for the secret where its server takes one", async () => {
    api.connectPlan.mockImplementation(async (id: string) => ({ needsSecret: id === "srv-pw", secretLabel: "Passphrase" }));
    const { flow, askSecret, cleanup } = await restoredManually(
      [tab("web"), tab("pw"), tab("l", { kind: "local" })],
      [server("srv-web"), server("srv-pw")],
    );
    await flow.wake("web");
    await flow.wake("pw");
    await flow.wake("l");
    expect(status("web")).toEqual({ waiting: null, status: "Connecting…", gen: 1 });
    expect(status("l")).toMatchObject({ waiting: null, gen: 1 });
    expect(status("pw")?.waiting).toBe("manual");
    expect(askSecret).toHaveBeenCalledWith(expect.objectContaining({ id: "srv-pw" }), "Passphrase", "pw");
    // A local shell needs no question about a secret.
    expect(api.connectPlan.mock.calls.map(([id]) => id)).toEqual(["srv-web", "srv-pw"]);
    cleanup();
  });

  it("a tab that is not waiting, or still being checked, is left alone; a failure is said", async () => {
    api.connectPlan.mockRejectedValueOnce(new Error("unknown server"));
    const { flow, cleanup } = await restoredManually([tab("web")], [server("srv-web")]);
    await flow.wake("web");
    expect(toasts.notifyError).toHaveBeenCalledTimes(1);
    expect(status("web")?.waiting).toBe("manual");
    await flow.wake("nobody");
    expect(api.connectPlan).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("⌘K opens every tab that may open without a question, and the rest say why", async () => {
    api.connectPlan.mockImplementation(async (id: string) => ({ needsSecret: id === "srv-pw", secretLabel: "Password" }));
    const { flow, cleanup } = await restoredManually(
      [tab("l", { kind: "local" }), tab("web"), tab("pw"), tab("prod"), tab("box", { attach: ATTACH })],
      [server("srv-web"), server("srv-pw"), server("srv-prod", { prod: true }), server("srv-box")],
    );
    flow.wakeAll();
    expect(status("l")).toMatchObject({ waiting: null, gen: 1 });
    expect(status("prod")?.waiting).toBe("prod");
    expect(status("box")?.waiting).toBe("attach");
    await settled();
    expect(status("web")).toEqual({ waiting: null, status: "Connecting…", gen: 1 });
    expect(status("pw")?.waiting).toBe("secret");
    cleanup();
  });
});

describe("restore flow: the windows of the previous launch (v1.36)", () => {
  it("open again with their tabs; one that does not gives them to the main window", async () => {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({
      main: slot([tab("a")]),
      others: [
        { label: "win-2", raw: slot([tab("w1")]) },
        { label: "win-3", raw: slot([tab("w2")]) },
      ],
    });
    api.reopenWindows.mockResolvedValue(["win-2"]);
    const { flow, cleanup } = harness([server("srv-a"), server("srv-w1"), server("srv-w2")]);
    await flow.restore();
    const [asked, background] = api.reopenWindows.mock.calls[0];
    expect(asked.map((w) => w.label)).toEqual(["win-2", "win-3"]);
    expect(JSON.parse(asked[0].record).tabs.map((t: { id: string }) => t.id)).toEqual(["w1"]);
    expect(background).toBe("#101010");
    // The slot is written from before the windows are asked: their slots go, they are handed their tabs.
    expect(keeper.startSavingTabs.mock.invocationCallOrder[0]).toBeLessThan(api.reopenWindows.mock.invocationCallOrder[0]);
    expect(tabsState.list.map((t) => t.sessionId).sort()).toEqual(["a", "w2"]);
    expect(status("w2")?.waiting).toBe("manual");
    cleanup();
  });

  it("a reopened window takes the tabs it was handed; a window opened for a tab takes none", async () => {
    settings.restoreTabs = "manual";
    const { flow, cleanup } = harness([server("srv-w1")]);
    expect(await flow.restoreWindow()).toBeNull();
    api.takeRestore.mockResolvedValue(JSON.stringify(slot([tab("w1"), tab("gone")])));
    expect(await flow.restoreWindow()).toBe(1);
    expect(status("w1")?.waiting).toBe("manual");
    // It reads no slot: the main window did.
    expect(keeper.takeSavedTabs).not.toHaveBeenCalled();
    cleanup();
  });

  it("a record that is not one brings nothing back", async () => {
    api.takeRestore.mockResolvedValue("{not json");
    const { flow, cleanup } = harness([]);
    expect(await flow.restoreWindow()).toBe(0);
    expect(tabsState.list).toEqual([]);
    cleanup();
  });
});

describe("restore flow: where a tab was (v1.36)", () => {
  const facts = (): TabFacts => ({
    shellCwd: "/srv/app",
    dock: {
      cwd: "/srv/app",
      files: { connected: true, cwd: "/srv/app/logs", home: "/home/deploy" },
      k8sScope: { context: "kind", namespace: "shop", allNamespaces: false },
    },
    workspace: {
      editors: [
        { id: "d1", source: "sftp", path: "/etc/hosts", name: "hosts", sudo: false } as never,
        { id: "d2", source: "sftp", path: "/etc/gone", name: "gone", sudo: false } as never,
      ],
      layout: addTab(addTab(addTab(emptyLayout(), "terminal"), "d1"), "d2"),
    },
  });

  it("the dock, the files and the shell's folder come back with the tab", async () => {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a")], facts), others: [] });
    const { flow, cleanup } = harness([server("srv-a")]);
    await flow.restore();
    expect(peekDockState("a")).toMatchObject({
      cwd: "/srv/app",
      files: { connected: true, cwd: "/srv/app/logs", home: "/home/deploy" },
      k8sScope: { context: "kind", namespace: "shop", allNamespaces: false },
    });
    const ws = getWorkspace("a");
    expect(ws.editors.map((e) => [e.id, e.awaiting, e.loading])).toEqual([
      ["d1", true, false],
      ["d2", true, false],
    ]);
    expect(findTab("a")?.startDir).toBe("/srv/app");
    // Nothing is read before the connection is open.
    expect(api.sftpReadText).not.toHaveBeenCalled();
    cleanup();
  });

  it("the files are read once the connection is open; one that cannot be says why", async () => {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a")], facts), others: [] });
    api.sftpReadText.mockImplementation(async (_sid: string, path: string) => {
      if (path === "/etc/gone") throw new Error("no such file");
      return { content: "127.0.0.1 localhost\n", sha256: "x", eol: "lf", encoding: "utf-8", mode: 420, readOnly: false };
    });
    const { flow, cleanup } = harness([server("srv-a")]);
    await flow.restore();
    flow.connected("a");
    await settled();
    await settled();
    const [hosts, gone] = getWorkspace("a").editors;
    expect(hosts).toMatchObject({ awaiting: false, loading: false, content: "127.0.0.1 localhost\n", loadError: null });
    expect(gone).toMatchObject({ awaiting: false, loading: false, loadError: "Error: no such file" });
    cleanup();
  });

  it("an SSH shell is taken to its folder once it says where it is — and only then", async () => {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a"), tab("b")], facts), others: [] });
    const { flow, cleanup } = harness([server("srv-a"), server("srv-b")]);
    await flow.restore();
    flow.connected("a");
    // Connected, but its shell has not said where it is: it could be a login menu.
    expect(api.writeToTerminal).not.toHaveBeenCalled();
    expect(findTab("a")?.startDir).toBe("/srv/app");
    flow.shellAt("a", "/home/deploy");
    expect(api.writeToTerminal).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(api.writeToTerminal.mock.calls[0][1])).toBe("cd '/srv/app'\r");
    expect(findTab("a")?.startDir).toBeUndefined();
    // Once: the next report is the shell's own business.
    flow.shellAt("a", "/tmp");
    // Already there: nothing to type.
    flow.shellAt("b", "/srv/app");
    expect(api.writeToTerminal).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("a local shell was started in its folder, and the folder is used up on connecting", async () => {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("l", { kind: "local", serverId: "" })], facts), others: [] });
    const { flow, cleanup } = harness([]);
    await flow.restore();
    expect(findTab("l")?.startDir).toBe("/srv/app");
    flow.connected("l");
    flow.shellAt("l", "/home/me");
    expect(api.writeToTerminal).not.toHaveBeenCalled();
    expect(findTab("l")?.startDir).toBeUndefined();
    cleanup();
  });
});

describe("restore flow: what the tabs printed (v1.36)", () => {
  const record = (savedAt: number, chat = true) =>
    contentRecord({
      savedAt,
      term: SNAPSHOT,
      chat: chat ? [{ role: "user", content: "why is it slow?" }, { role: "assistant", content: "the disk" }] : null,
    });

  it("is not read, and what was kept goes, while the setting is off", async () => {
    settings.restoreTabs = "manual";
    settings.restoreOutput = false;
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a")]), others: [] });
    const { flow, cleanup } = harness([server("srv-a")]);
    await flow.restore();
    expect(api.tabContentLoad).not.toHaveBeenCalled();
    expect(api.tabContentKeepOnly).toHaveBeenCalledWith([]);
    expect(findTab("a")?.replay).toBeUndefined();
    cleanup();
  });

  it("comes back under the setting — never for a production server", async () => {
    settings.restoreTabs = "manual";
    settings.restoreOutput = true;
    keeper.takeSavedTabs.mockReturnValue({
      main: slot([tab("a"), tab("p")]),
      others: [{ label: "win-2", raw: slot([tab("w")]) }],
    });
    api.tabContentLoad.mockImplementation(async () => record(1_700_000_000_000));
    // The other window opens again and reads its own tabs' content.
    api.reopenWindows.mockResolvedValue(["win-2"]);
    const { flow, cleanup } = harness([server("srv-a"), server("srv-p", { prod: true }), server("srv-w")]);
    await flow.restore();
    // What no tab that came back holds goes; the other window's tabs keep theirs.
    expect(api.tabContentKeepOnly).toHaveBeenCalledWith(["a", "p", "w"]);
    expect(api.tabContentLoad.mock.calls.map(([id]) => id)).toEqual(["a"]);
    expect(findTab("a")?.replay).toEqual({ term: SNAPSHOT, savedAt: 1_700_000_000_000 });
    expect(peekChat("a")?.messages.map((m) => m.content)).toEqual(["why is it slow?", "the disk"]);
    expect(findTab("p")?.replay).toBeUndefined();
    expect(peekChat("p")).toBeNull();
    // Shown until the session opens; a reconnect after that starts empty.
    flow.connected("a");
    expect(findTab("a")?.replay).toBeUndefined();
    cleanup();
  });

  it("is written down when it changed, and a quit writes what changed since", async () => {
    settings.restoreOutput = true;
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a"), tab("b"), tab("p")]), others: [] });
    const { flow, keepsake, cleanup } = harness([server("srv-a"), server("srv-b"), server("srv-p", { prod: true })]);
    await flow.restore();
    flow.printed("a");
    flow.printed("p");
    await flow.flush();
    expect(api.tabContentSave.mock.calls.map(([id]) => id)).toEqual(["a"]);
    expect(keepsake.mock.calls.map(([id]) => id)).toEqual(["a"]);
    const saved = JSON.parse(api.tabContentSave.mock.calls[0][1]);
    expect(saved.term.data).toBe(SNAPSHOT.data);
    // Nothing changed since: nothing written. A new turn of the conversation is a change.
    await flow.flush();
    expect(api.tabContentSave).toHaveBeenCalledTimes(1);
    getChat("b").messages = [{ role: "user", content: "hello" }];
    await flow.flush();
    expect(api.tabContentSave.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    cleanup();
  });

  it("a server marked production since loses what was kept of it", async () => {
    settings.restoreOutput = true;
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a")]), others: [] });
    api.tabContentLoad.mockResolvedValue(record(1, false));
    const servers = [server("srv-a")];
    const { flow, cleanup } = harness(servers);
    await flow.restore();
    servers[0] = server("srv-a", { prod: true });
    flow.printed("a");
    await flow.flush();
    expect(api.tabContentSave).not.toHaveBeenCalled();
    expect(api.tabContentForget).toHaveBeenCalledWith(["a"]);
    cleanup();
  });

  it("goes with the tab, and all of it with the setting", async () => {
    settings.restoreOutput = true;
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a")]), others: [] });
    const { flow, cleanup } = harness([server("srv-a")]);
    await flow.restore();
    flow.forget("a");
    expect(api.tabContentForget).toHaveBeenCalledWith(["a"]);
    api.tabContentKeepOnly.mockClear();
    flow.settingsChanged();
    expect(api.tabContentKeepOnly).not.toHaveBeenCalled();
    settings.restoreOutput = false;
    flow.settingsChanged();
    expect(api.tabContentKeepOnly).toHaveBeenCalledWith([]);
    // A quit with the setting off writes nothing.
    flow.printed("a");
    await flow.flush();
    expect(api.tabContentSave).not.toHaveBeenCalled();
    cleanup();
  });
});
