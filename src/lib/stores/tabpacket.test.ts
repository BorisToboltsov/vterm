import { beforeEach, describe, expect, it, vi } from "vitest";

// The stores below reach the backend only when something is started; nothing
// here starts anything, so the bridge is a stub.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { panes } from "../splitlayout";
import { paneMoveOrder, parsePacket, type TermSnapshot } from "../tabhandoff";
import { aiChatState, getChat, peekChat, removeChat } from "./aichat.svelte";
import {
  beginUpload,
  dockState,
  peekDockState,
  removeDockState,
  resetDockState,
} from "./dockstate.svelte";
import {
  clearRecording,
  isRecording,
  isRecordingPaused,
  recordingState,
  setRecording,
  setRecordingPausedState,
} from "./recordings.svelte";
import { peekSyncJob, removeSyncJob, resetSyncJobs, syncJob } from "./syncjob.svelte";
import { packTab, unpackTab, type PageFacts } from "./tabpacket";
import {
  clearAdopt,
  closeTab,
  findTab,
  openLocalTab,
  openTab,
  reconnectTab,
  resetTabs,
  setTabStatus,
  tabsState,
} from "./tabs.svelte";
import {
  addScratchEditor,
  getWorkspace,
  isDirty,
  peekWorkspace,
  removeWorkspace,
  setEditorSudo,
  splitSessionView,
  workspacesState,
} from "./workspaces.svelte";
import { TERMINAL_VIEW } from "../sessionviews";

const SNAPSHOT: TermSnapshot = {
  cols: 132,
  rows: 43,
  data: "\u001b[32m$ uptime\u001b[0m\r\n 14:05 up 3 days",
  commands: ["uptime", "ls -la"],
};

const FACTS: PageFacts = {
  terminalCwd: "/var/log",
  followTerminal: true,
  followSeen: "/var/log",
  localShell: null,
  shellIntegrated: true,
};

/** What `closeTabFully` does to the stores in the window giving the tab up. */
function leave(sessionId: string) {
  removeWorkspace(sessionId);
  removeChat(sessionId);
  removeDockState(sessionId);
  removeSyncJob(sessionId);
  clearRecording(sessionId);
  closeTab(sessionId);
}

beforeEach(() => {
  resetTabs();
  resetDockState();
  resetSyncJobs();
  workspacesState.map = {};
  aiChatState.map = {};
  for (const id of Object.keys(recordingState)) clearRecording(id);
});

describe("a tab's packet", () => {
  it("is nothing for a tab that is not here", () => {
    expect(packTab("gone", SNAPSHOT, FACTS)).toBeNull();
  });

  it("carries the tab with its credentials, and the terminal as snapshotted", () => {
    const sid = openTab("srv-1", "web", "hunter2", true);
    setTabStatus(sid, "connected");
    const packet = parsePacket(packTab(sid, SNAPSHOT, FACTS));
    expect(packet?.tab).toMatchObject({
      sessionId: sid,
      kind: "ssh",
      serverId: "srv-1",
      alias: "web",
      secret: "hunter2",
      remember: true,
      status: "Connected",
    });
    expect(packet?.terminal).toEqual(SNAPSHOT);
    expect(packet?.page).toEqual({ ...FACTS, recording: null, recordingPaused: false });
  });

  it("moves everything the stores hold for the tab, and leaves nothing behind", () => {
    const other = openLocalTab();
    const sid = openTab("srv-1", "web", null, false, {
      kind: "container",
      name: "nginx",
      argv: ["docker", "exec", "-it", "nginx", "sh"],
    } as never);
    setTabStatus(sid, "connected");
    // Editors: one with unsaved edits, opened as root.
    const ed = addScratchEditor(sid, "notes.txt", { kind: "plain", label: "Text" }, "draft");
    setEditorSudo(sid, ed, "s3cret");
    // The conversation, and a chip waiting in the composer.
    const chat = getChat(sid);
    chat.messages.push({ role: "user", content: "why is nginx down?" });
    chat.attachment = { source: "selection", context: "502 Bad Gateway" } as never;
    // What the dock remembers.
    const dock = dockState(sid);
    dock.files = { connected: true, cwd: "/etc/nginx", home: "/root" };
    dock.cwd = "/etc/nginx";
    dock.k8sScope = { context: "prod", namespace: "web", allNamespaces: false };
    dock.sub.git = "log";
    // The sync form, and a recording that is running but paused.
    const job = syncJob(sid);
    job.localPath = "/Users/me/site";
    job.remote = "/srv/site";
    job.deleteExtraneous = true;
    setRecording(sid, "/rec/a.cast");
    setRecordingPausedState(sid, true);

    const raw = packTab(sid, SNAPSHOT, FACTS);
    leave(sid);
    expect(findTab(sid)).toBeNull();
    expect([peekWorkspace(sid), peekChat(sid), peekDockState(sid), peekSyncJob(sid)]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(isRecording(sid)).toBe(false);

    // …and in the window taking it:
    const packet = parsePacket(raw);
    expect(packet).not.toBeNull();
    unpackTab(packet!);

    const tab = findTab(sid);
    expect(tab).toMatchObject({ kind: "ssh", serverId: "srv-1", status: "Connected", gen: 0 });
    expect(tab?.attach).toMatchObject({ name: "nginx" });
    expect(tab?.adopt).toEqual(SNAPSHOT);
    // It is shown, in the pane in focus, and nothing else moved. Its open file
    // came with it, inside it (v1.11): the centre holds connections only.
    expect(tabsState.activeId).toBe(sid);
    expect(panes(tabsState.center).flatMap((p) => p.tabs)).toEqual([other, sid]);

    const ws = getWorkspace(sid);
    expect(ws.editors).toHaveLength(1);
    expect(ws.editors[0]).toMatchObject({
      name: "notes.txt",
      content: "draft",
      sudo: true,
      sudoPassword: "s3cret",
    });
    expect(isDirty(ws.editors[0])).toBe(true);

    expect(peekChat(sid)?.messages).toEqual([{ role: "user", content: "why is nginx down?" }]);
    expect(peekChat(sid)?.attachment).toEqual({ source: "selection", context: "502 Bad Gateway" });

    expect(peekDockState(sid)).toMatchObject({
      files: { connected: true, cwd: "/etc/nginx", home: "/root" },
      cwd: "/etc/nginx",
      k8sScope: { context: "prod", namespace: "web", allNamespaces: false },
      sub: { git: "log" },
    });
    expect(peekSyncJob(sid)).toMatchObject({
      localPath: "/Users/me/site",
      remote: "/srv/site",
      deleteExtraneous: true,
    });
    expect(recordingState[sid]).toBe("/rec/a.cast");
    expect(isRecordingPaused(sid)).toBe(true);
  });

  it("a tab with nothing but a terminal arrives with nothing but a terminal", () => {
    const sid = openLocalTab();
    setTabStatus(sid, "connected");
    const raw = packTab(sid, SNAPSHOT, { ...FACTS, localShell: "posix" });
    leave(sid);
    unpackTab(parsePacket(raw)!);
    expect(findTab(sid)?.kind).toBe("local");
    expect([peekWorkspace(sid), peekChat(sid), peekDockState(sid), peekSyncJob(sid)]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(isRecording(sid)).toBe(false);
  });

  it("never claims work in flight in the window taking the tab", () => {
    // A tab moves only while idle (detachBlocker); the flags are reset anyway —
    // a stream, a compare or an upload cannot be carried, so none may be claimed.
    const sid = openTab("srv-1", "web", null, false);
    setTabStatus(sid, "connected");
    const chat = getChat(sid);
    chat.streaming = true;
    chat.dialogRunning = true;
    chat.pending = { command: "rm -rf /tmp/x", opts: {} as never };
    const job = syncJob(sid);
    job.comparing = true;
    job.applying = true;
    job.stopping = true;
    job.phase = "running";
    job.dialogOpen = true;
    beginUpload(sid, "/srv");

    const packet = parsePacket(packTab(sid, SNAPSHOT, FACTS))!;
    // Dropped by hand: the teardown would stop the (pretend) run through the backend.
    resetTabs();
    resetDockState();
    resetSyncJobs();
    aiChatState.map = {};
    unpackTab(packet);

    expect(peekChat(sid)).toMatchObject({ streaming: false, dialogRunning: false, pending: null });
    expect(peekSyncJob(sid)).toMatchObject({
      comparing: false,
      applying: false,
      stopping: false,
      phase: "idle",
      dialogOpen: false,
    });
    expect(peekDockState(sid)?.uploads).toEqual({});
  });

  it("a tab that arrived once can be moved on without its old snapshot", () => {
    const sid = openLocalTab();
    setTabStatus(sid, "connected");
    const first = parsePacket(packTab(sid, SNAPSHOT, FACTS))!;
    resetTabs();
    unpackTab(first);
    expect(findTab(sid)?.adopt).toEqual(SNAPSHOT);
    // Its terminal has not even taken over yet — the next packet still carries
    // only the snapshot it is given, never the one the tab came with.
    const next = { ...SNAPSHOT, data: "later" };
    const second = parsePacket(packTab(sid, next, FACTS))!;
    expect(second.terminal).toEqual(next);
    expect("adopt" in second.tab).toBe(false);
  });
});

describe("a tab taken over from another window", () => {
  const arrive = () => {
    const sid = openLocalTab();
    setTabStatus(sid, "connected");
    const packet = parsePacket(packTab(sid, SNAPSHOT, FACTS))!;
    resetTabs();
    unpackTab(packet);
    return { sid, packet };
  };

  it("restores its snapshot once: taking over uses it up", () => {
    const { sid } = arrive();
    expect(findTab(sid)?.adopt).toEqual(SNAPSHOT);
    const before = tabsState.list;
    clearAdopt(sid);
    expect(findTab(sid)?.adopt).toBeUndefined();
    expect(findTab(sid)?.status).toBe("Connected");
    // Nothing to clear the second time — and the list is left alone.
    const after = tabsState.list;
    expect(after).not.toBe(before);
    clearAdopt(sid);
    clearAdopt("unknown");
    expect(tabsState.list).toBe(after);
  });

  it("a reconnect is an ordinary connect, even before it took over", () => {
    const { sid } = arrive();
    reconnectTab(sid);
    expect(findTab(sid)).toMatchObject({ status: "Connecting…", gen: 1 });
    expect(findTab(sid)?.adopt).toBeUndefined();
  });

  it("is not added twice", () => {
    const { sid, packet } = arrive();
    unpackTab(packet);
    expect(tabsState.list.filter((t) => t.sessionId === sid)).toHaveLength(1);
    expect(panes(tabsState.center).flatMap((p) => p.tabs)).toEqual([sid]);
  });
});

describe("a pane taken over from another window (v1.10)", () => {
  /** Pack the tabs of this window's only pane as its move would, then start afresh. */
  const packPane = (count: number, shownAt: number) => {
    const ids = Array.from({ length: count }, () => openLocalTab());
    for (const id of ids) setTabStatus(id, "connected");
    const packets = paneMoveOrder(ids, ids[shownAt]).map(
      (step) => parsePacket(packTab(step.tab, SNAPSHOT, FACTS, step.seat))!,
    );
    resetTabs();
    return { ids, packets };
  };

  it("the seat travels in the packet; a tab that goes alone has none", () => {
    const { ids, packets } = packPane(3, 1);
    expect(packets.map((p) => [p.tab.sessionId, p.seat])).toEqual([
      [ids[1], { lead: null, before: false }],
      [ids[0], { lead: ids[1], before: true }],
      [ids[2], { lead: ids[1], before: false }],
    ]);
    const alone = openLocalTab();
    expect(parsePacket(packTab(alone, SNAPSHOT, FACTS))?.seat).toBeNull();
  });

  it("arrives in its order, showing the tab it showed", () => {
    const { ids, packets } = packPane(4, 2);
    for (const packet of packets) unpackTab(packet);
    const [pane] = panes(tabsState.center);
    expect(pane.tabs).toEqual(ids);
    expect(pane.active).toBe(ids[2]);
    expect(tabsState.activeId).toBe(ids[2]);
    // Each of them restores its snapshot, shown or not.
    for (const id of ids) expect(findTab(id)?.adopt).toEqual(SNAPSHOT);
  });

  it("joins a window that has tabs of its own without changing what it showed", () => {
    const { ids, packets } = packPane(3, 0);
    const own = openLocalTab();
    // The first tab was given a pane of its own beside the one in focus.
    const [first, ...rest] = packets;
    unpackTab(first, { kind: "pane", pane: tabsState.center.focus, zone: "right" });
    for (const packet of rest) unpackTab(packet);
    expect(panes(tabsState.center).map((p) => ({ tabs: p.tabs, active: p.active }))).toEqual([
      { tabs: [own], active: own },
      { tabs: ids, active: ids[0] },
    ]);
  });

  it("a tab whose lead is no longer there still arrives — where a new tab goes, unseen", () => {
    const { ids, packets } = packPane(2, 0);
    const own = openLocalTab();
    unpackTab(packets[1]);
    expect(panes(tabsState.center)[0]).toMatchObject({ tabs: [own, ids[1]], active: own });
  });

  it("each connection brings its files inside it, in the zones they stood in", () => {
    const ids = [openLocalTab(), openLocalTab()];
    for (const id of ids) setTabStatus(id, "connected");
    const doc = addScratchEditor(ids[0], "notes.txt", { kind: "plain", label: "Text" }, "draft");
    // The file beside its terminal.
    splitSessionView(ids[0], doc, "right");
    const packets = paneMoveOrder(ids, ids[0]).map(
      (step) => parsePacket(packTab(step.tab, SNAPSHOT, FACTS, step.seat))!,
    );
    removeWorkspace(ids[0]);
    resetTabs();
    for (const packet of packets) unpackTab(packet);
    // The pane holds the connections, in their order — and nothing else.
    const [pane] = panes(tabsState.center);
    expect(pane.tabs).toEqual(ids);
    expect(pane.active).toBe(ids[0]);
    // The file came inside its connection, still beside the terminal.
    const zones = panes(getWorkspace(ids[0]).layout).map((zone) => zone.tabs);
    expect(zones).toEqual([[TERMINAL_VIEW], [doc]]);
    expect(getWorkspace(ids[0]).editors[0]).toMatchObject({ name: "notes.txt", content: "draft" });
    expect(peekWorkspace(ids[1])).toBeNull();
  });
});
