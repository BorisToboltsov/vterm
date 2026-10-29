import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  startRecording: vi.fn(async (id: string) => `/rec/${id}.cast`),
  stopRecording: vi.fn(async (id: string) => `/rec/${id}.cast`),
  setRecordingPaused: vi.fn(async () => {}),
  setRecordingMeta: vi.fn(async () => {}),
  deleteRecording: vi.fn(async () => {}),
  setBatchLabel: vi.fn(async () => {}),
  fetchMetrics: vi.fn(async () => {
    throw new Error("no probe in tests");
  }),
}));
vi.mock("../api", () => api);
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.25.2") }));

import { createRecordingFlow, type RecordingFlow } from "./recordingflow.svelte";
import { clearRecording, isRecording, isRecordingPaused } from "../stores/recordings.svelte";
import { settings } from "../settings/settings.svelte";
import type { Tab } from "../stores/tabs.svelte";
import type { ServerProfile } from "../types";

const tab = (sessionId: string, over: Partial<Tab> = {}): Tab =>
  ({
    sessionId,
    kind: "ssh",
    serverId: `srv-${sessionId}`,
    alias: sessionId,
    secret: null,
    remember: false,
    status: "Connected",
    gen: 0,
    ...over,
  }) as Tab;

const server = (id: string, over: Partial<ServerProfile> = {}): ServerProfile =>
  ({ id, alias: `alias-${id}`, host: "h", port: 22, username: "u", tags: [], ...over }) as ServerProfile;

/** A flow over a page whose state the test owns; `onScreen` is reactive. */
function harness(tabs: Tab[], servers: ServerProfile[] = []) {
  const state = $state({
    onScreen: new Set<string>(tabs.map((t) => t.sessionId)),
    members: [] as string[],
    broadcasting: false,
    active: tabs[0] as Tab | undefined,
  });
  let flow!: RecordingFlow;
  const cleanup = $effect.root(() => {
    flow = createRecordingFlow({
      servers: () => servers,
      findTab: (id) => tabs.find((t) => t.sessionId === id),
      activeTab: () => state.active,
      broadcasting: () => state.broadcasting,
      members: () => state.members,
      orderedTabs: () => tabs,
      onScreen: () => state.onScreen,
      termSize: () => ({ cols: 120, rows: 40 }),
      promptLine: () => "$ ",
    });
  });
  return { flow, state, cleanup };
}

const IDS = ["a", "b", "c"];

beforeEach(() => {
  vi.clearAllMocks();
  for (const id of IDS) clearRecording(id);
  settings.recordIdlePauseSecs = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recording flow", () => {
  it("REC starts a recording with the terminal's size and prompt; a stop asks to name it", async () => {
    const t = tab("a");
    const { flow, cleanup } = harness([t], [server("srv-a")]);
    await flow.toggleRecordingFor(t);
    expect(isRecording("a")).toBe(true);
    const [id, title, cols, rows, prompt, env] = api.startRecording.mock.calls[0] as unknown as [
      string,
      string,
      number,
      number,
      string,
      string,
    ];
    expect([id, title, cols, rows, prompt]).toEqual(["a", "alias-srv-a", 120, 40, "$ "]);
    expect(JSON.parse(env)).toMatchObject({ appVersion: "1.25.2", connectedHost: "h" });

    await flow.toggleRecordingFor(t);
    expect(api.stopRecording).toHaveBeenCalledWith("a");
    expect(isRecording("a")).toBe(false);
    expect(flow.saveRec).toEqual({ path: "/rec/a.cast", defaultTitle: "alias-srv-a" });
    cleanup();
  });

  it("refuses a tab whose session is not live", async () => {
    const t = tab("a", { status: "Disconnected" });
    const { flow, cleanup } = harness([t]);
    await flow.toggleRecordingFor(t);
    expect(api.startRecording).not.toHaveBeenCalled();
    cleanup();
  });

  it("records a broadcast group under one batch and offers the bundle on stop", async () => {
    const tabs = [tab("a"), tab("b"), tab("c", { status: "Disconnected" })];
    const { flow, state, cleanup } = harness(tabs);
    state.broadcasting = true;
    state.members = ["a", "b", "c"];
    await flow.toggle(2);
    // Only live members record, each tagged with the same batch id.
    const batches = api.startRecording.mock.calls.map(
      (c) => JSON.parse((c as unknown as string[])[5]).batch as string,
    );
    expect(api.startRecording.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    expect(new Set(batches).size).toBe(1);
    expect(flow.batch).toBe(batches[0]);

    await flow.toggle(2);
    expect(api.stopRecording.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
    expect(flow.batch).toBeNull();
    expect(flow.saveBatch).toEqual({ batchId: batches[0], paths: ["/rec/a.cast", "/rec/b.cast"] });
    cleanup();
  });

  it("stops the recording of a member that leaves the group", async () => {
    const { flow, state, cleanup } = harness([tab("a"), tab("b")]);
    state.broadcasting = true;
    state.members = ["a", "b"];
    await flow.ensureGroupRecording();
    state.members = ["a"];
    await flow.syncBatchRecording();
    expect(api.stopRecording).toHaveBeenCalledWith("b");
    expect(isRecording("b")).toBe(false);
    expect(isRecording("a")).toBe(true);
    cleanup();
  });

  it("pauses a recording off screen, and one on screen once it idles; typing resumes it", async () => {
    vi.useFakeTimers();
    settings.recordIdlePauseSecs = 5;
    const a = tab("a");
    const b = tab("b");
    const { flow, state, cleanup } = harness([a, b]);
    await flow.toggleRecordingFor(a);
    await flow.toggleRecordingFor(b);
    state.onScreen = new Set(["a"]);
    flushSync();
    expect(isRecordingPaused("b")).toBe(true);
    expect(api.setRecordingPaused).toHaveBeenCalledWith("b", true);
    expect(isRecordingPaused("a")).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(isRecordingPaused("a")).toBe(true);
    flow.activity("a");
    expect(isRecordingPaused("a")).toBe(false);
    expect(api.setRecordingPaused).toHaveBeenLastCalledWith("a", false);
    // Typing into a terminal that is not on screen changes nothing.
    flow.activity("b");
    expect(isRecordingPaused("b")).toBe(true);
    cleanup();
  });

  it("auto-records only SSH tabs of servers flagged for it", async () => {
    const servers = [server("srv-a", { autoRecord: true }), server("srv-b")];
    const { flow, cleanup } = harness([tab("a"), tab("b")], servers);
    await flow.maybeAutoRecord(tab("a"));
    await flow.maybeAutoRecord(tab("b"));
    await flow.maybeAutoRecord(tab("c", { kind: "local", serverId: "srv-a" }));
    expect(api.startRecording.mock.calls.map((c) => c[0])).toEqual(["a"]);
    cleanup();
  });

  it("finalizes on close and forgets a session handed away", async () => {
    const { flow, state, cleanup } = harness([tab("a"), tab("b")]);
    state.broadcasting = true;
    state.members = ["a", "b"];
    await flow.ensureGroupRecording();
    await flow.finalizeOnClose("a");
    expect(api.stopRecording).toHaveBeenCalledWith("a");
    expect(isRecording("a")).toBe(false);
    // A tab given to another window keeps recording there: this window only forgets it.
    flow.forget("b");
    await flow.toggle(2);
    expect(api.stopRecording).not.toHaveBeenCalledWith("b");
    cleanup();
  });

  it("names, discards and dismisses what was just recorded", async () => {
    const t = tab("a");
    const { flow, cleanup } = harness([t]);
    await flow.toggleRecordingFor(t);
    await flow.toggleRecordingFor(t);
    await flow.saveRecording("deploy", "notes");
    expect(api.setRecordingMeta).toHaveBeenCalledWith("/rec/a.cast", "deploy", "notes");
    expect(flow.saveRec).toBeNull();

    await flow.toggleRecordingFor(t);
    await flow.toggleRecordingFor(t);
    await flow.discardRecording();
    expect(api.deleteRecording).toHaveBeenCalledWith("/rec/a.cast");
    cleanup();
  });
});
