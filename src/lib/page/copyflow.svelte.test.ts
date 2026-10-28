import { flushSync, tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  announceCopyTargets: vi.fn(async () => {}),
  sftpHome: vi.fn(async (id: string) => `/home/${id}`),
  localHome: vi.fn(async () => "/Users/me"),
}));
vi.mock("../api", () => api);
const flow = vi.hoisted(() => ({ startTransfer: vi.fn(async (_spec: unknown) => {}) }));
vi.mock("../transferflow", () => ({ DISK: { kind: "disk" }, startTransfer: flow.startTransfer }));

import { createCopyFlow, type CopyFlow } from "./copyflow.svelte";
import { copyTargetList, requestCopy, resetFileCopy } from "../stores/filecopy.svelte";
import type { Tab } from "../stores/tabs.svelte";
import type { CopyTarget } from "../copyto";

const tab = (sessionId: string, over: Partial<Tab> = {}): Tab =>
  ({
    sessionId,
    kind: "ssh",
    serverId: `srv-${sessionId}`,
    alias: sessionId,
    status: "Connected",
    gen: 0,
    ...over,
  }) as Tab;

function harness(initial: Tab[], cwd: Record<string, string> = {}) {
  const state = $state({ tabs: initial });
  let copy!: CopyFlow;
  const cleanup = $effect.root(() => {
    copy = createCopyFlow({
      tabs: () => state.tabs,
      findTab: (id) => state.tabs.find((t) => t.sessionId === id),
      title: (t) => `title-${t.sessionId}`,
      isProd: (id) => id === "prod",
      terminalCwd: (id) => cwd[id] ?? null,
    });
  });
  flushSync();
  return { copy, state, cleanup };
}

const other: CopyTarget = { sessionId: "far", title: "far", local: false, prod: false } as CopyTarget;

beforeEach(() => {
  vi.clearAllMocks();
  resetFileCopy();
});

describe("copy flow", () => {
  it("offers this window's connected tabs, then what other windows offer", () => {
    const { copy, cleanup } = harness([tab("a"), tab("prod"), tab("down", { status: "Disconnected" })]);
    expect(copy.mine.map((x) => [x.sessionId, x.title, x.prod])).toEqual([
      ["a", "title-a", false],
      ["prod", "title-prod", true],
    ]);
    copy.heardOthers([other]);
    flushSync();
    expect(copy.all.map((x) => x.sessionId)).toEqual(["a", "prod", "far"]);
    // The file panels read the same list from the store.
    expect(copyTargetList().map((x) => x.sessionId)).toEqual(["a", "prod", "far"]);
    cleanup();
  });

  it("tells the other windows only when this window's list changes", () => {
    const { state, cleanup } = harness([tab("a")]);
    expect(api.announceCopyTargets).toHaveBeenCalledTimes(1);
    // A change that leaves the offered list as it was: nothing is said again.
    state.tabs = [tab("a", { gen: 7 })];
    flushSync();
    expect(api.announceCopyTargets).toHaveBeenCalledTimes(1);
    state.tabs = [tab("a"), tab("b")];
    flushSync();
    expect(api.announceCopyTargets).toHaveBeenCalledTimes(2);
    cleanup();
  });

  // The last case once failed silently in the page: a deep $state handed back a
  // proxy of the request, `open` did not recognise it, and the field stayed empty.
  it("prefills the folder: where it was dropped, else the target terminal's, else the home there", async () => {
    const { copy, cleanup } = harness([tab("a"), tab("b"), tab("l", { kind: "local" })], { b: "/srv/app" });
    const request = { from: "a", local: false, to: "b", entries: [] };
    await copy.open(request, "/drop/here");
    expect(copy.dir).toBe("/drop/here");
    await copy.open(request);
    expect(copy.dir).toBe("/srv/app");
    expect(api.sftpHome).not.toHaveBeenCalled();
    await copy.open({ ...request, to: "l" });
    expect(api.localHome).toHaveBeenCalled();
    expect(copy.dir).toBe("/Users/me");
    expect(copy.ask?.target.sessionId).toBe("l");
    cleanup();
  });

  it("ignores a request for a session that cannot take files", async () => {
    const { copy, cleanup } = harness([tab("a")]);
    await copy.open({ from: "a", local: false, to: "gone", entries: [] });
    expect(copy.ask).toBeNull();
    cleanup();
  });

  it("opens the dialog for a request a file panel filed", async () => {
    const { copy, cleanup } = harness([tab("a"), tab("b")], { b: "/x" });
    requestCopy({ from: "a", local: false, to: "b", entries: [{ path: "/x", name: "x", isDir: false }] });
    flushSync();
    await tick();
    expect(copy.ask?.target.sessionId).toBe("b");
    cleanup();
  });

  it("starts the transfer from the source tab to the chosen folder and closes the dialog", async () => {
    const { copy, cleanup } = harness([tab("a"), tab("b")], { b: "/x" });
    const entries = [{ path: "/etc/x", name: "x", isDir: false }];
    await copy.open({ from: "a", local: false, to: "b", entries });
    copy.confirm("/dest");
    expect(copy.ask).toBeNull();
    const spec = flow.startTransfer.mock.calls[0][0] as unknown as {
      src: { session?: string; label?: string };
      dst: { session?: string };
      sources: unknown[];
      destDir: string;
    };
    expect(spec.src).toMatchObject({ session: "a", label: "title-a" });
    expect(spec.dst).toMatchObject({ session: "b" });
    expect(spec.sources).toEqual([{ path: "/etc/x", isDir: false }]);
    expect(spec.destDir).toBe("/dest");
    cleanup();
  });

  it("copies files from the desktop as the disk side", async () => {
    const { copy, cleanup } = harness([tab("b")], { b: "/x" });
    await copy.open({ from: null, local: true, to: "b", entries: [] });
    copy.confirm("/x");
    expect((flow.startTransfer.mock.calls[0][0] as unknown as { src: unknown }).src).toEqual({ kind: "disk" });
    cleanup();
  });
});
