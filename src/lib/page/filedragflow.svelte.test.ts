import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  dragDrop: vi.fn(async (): Promise<unknown> => null),
  dragEnd: vi.fn(async () => {}),
  dragOutBegin: vi.fn(async () => true),
  dragOver: vi.fn(async () => null),
  localKinds: vi.fn(async (paths: string[]) => paths.map((p) => p.endsWith("/"))),
}));
vi.mock("../api", () => api);
const drag = vi.hoisted(() => ({
  host: null as null | Record<string, (...a: never[]) => unknown>,
  state: { files: null as unknown, over: null as unknown, outside: false },
  clearGuestFiles: vi.fn(),
  dropGuestFiles: vi.fn(),
  showGuestFiles: vi.fn(),
}));
vi.mock("../stores/filedrag.svelte", () => ({
  onFileDrag: (h: typeof drag.host) => (drag.host = h),
  fileDrag: drag.state,
  clearGuestFiles: drag.clearGuestFiles,
  dropGuestFiles: drag.dropGuestFiles,
  showGuestFiles: drag.showGuestFiles,
}));
const stores = vi.hoisted(() => ({
  requestMove: vi.fn(),
  revealPanel: vi.fn(),
  activateTab: vi.fn(),
  notifyInfo: vi.fn(),
  startTransfer: vi.fn(async () => {}),
  os: "macos",
  tabs: [] as { sessionId: string; kind: "ssh" | "local"; status: string; alias: string }[],
}));
vi.mock("../stores/filecopy.svelte", () => ({ requestMove: stores.requestMove }));
vi.mock("../stores/layout.svelte", () => ({ revealPanel: stores.revealPanel }));
vi.mock("../stores/toasts.svelte", () => ({ notifyInfo: stores.notifyInfo }));
vi.mock("../stores/hostenv.svelte", () => ({ hostEnv: { get os() { return stores.os; } } }));
vi.mock("../transferflow", () => ({ DISK: { kind: "disk" }, startTransfer: stores.startTransfer }));
vi.mock("../stores/tabs.svelte", () => ({
  activateTab: stores.activateTab,
  findTab: (id: string) => stores.tabs.find((t) => t.sessionId === id) ?? null,
  tabsState: {
    get list() {
      return stores.tabs;
    },
    activeId: "a",
  },
}));

import { createFileDragFlow, type FileDragFlow } from "./filedragflow.svelte";
import type { CarriedFiles } from "../filedrop";
import type { CopyTarget } from "../copyto";

type Host = {
  meaning: (f: CarriedFiles, t: unknown) => unknown;
  drop: (f: CarriedFiles, m: unknown) => void;
  spring: (w: unknown) => void;
  over: (f: CarriedFiles) => Promise<unknown>;
  release: (f: CarriedFiles) => void;
  left: () => void;
  out: (f: CarriedFiles) => Promise<boolean>;
};

const files = (from: string | null, paths: string[], over: Partial<CarriedFiles> = {}): CarriedFiles => ({
  from,
  local: from === null || from === "l",
  label: "",
  entries: paths.map((path) => ({ path, name: path.split("/").pop() ?? path, isDir: false })),
  ...over,
});

const settled = () => new Promise((r) => setTimeout(r, 0));

function harness(otherWindows = false) {
  const deps = {
    title: vi.fn((tab: { alias: string }) => `title-${tab.alias}`),
    copy: { open: vi.fn(async () => {}), mine: [{ sessionId: "b", title: "b", local: false, prod: false } as CopyTarget] },
    localShell: vi.fn(() => "posix" as const),
    paste: vi.fn(),
    otherWindows: () => otherWindows,
    ghostLook: () => null,
  };
  let flow!: FileDragFlow;
  const cleanup = $effect.root(() => {
    flow = createFileDragFlow(deps);
  });
  flushSync();
  return { flow, host: drag.host as unknown as Host, deps, cleanup };
}

beforeEach(() => {
  vi.clearAllMocks();
  drag.host = null;
  drag.state.files = null;
  drag.state.outside = false;
  stores.os = "macos";
  stores.tabs = [
    { sessionId: "a", kind: "ssh", status: "Connected", alias: "web" },
    { sessionId: "b", kind: "ssh", status: "Connected", alias: "db" },
    { sessionId: "l", kind: "local", status: "Connected", alias: "Local shell" },
  ];
});

describe("file drag flow: what a drop does", () => {
  it("is the store's host while the page lives, and none after", () => {
    const { host, cleanup } = harness();
    expect(host).not.toBeNull();
    cleanup();
    expect(drag.host).toBeNull();
  });

  it("inside its own panel it is that panel's move, with its question — never a move done here", () => {
    const { host, cleanup } = harness();
    const f = files("a", ["/srv/a.txt"]);
    const meaning = host.meaning(f, { kind: "folder", session: "a", dir: "/srv/sub" });
    expect(meaning).toEqual({ kind: "move", session: "a", dir: "/srv/sub" });
    host.drop(f, meaning);
    expect(stores.requestMove).toHaveBeenCalledWith({ session: "a", paths: ["/srv/a.txt"], dir: "/srv/sub" });
    // Into the folder they are in: no move at all, and not offered.
    expect(host.meaning(f, { kind: "folder", session: "a", dir: "/srv" })).toBeNull();
    cleanup();
  });

  it("onto another session it is a copy through the dialog, named after its tab", async () => {
    const { host, deps, cleanup } = harness();
    const f = files("a", ["/srv/a.txt"]);
    const meaning = host.meaning(f, { kind: "folder", session: "b", dir: "/data" });
    expect(meaning).toEqual({ kind: "copy", to: "b", dir: "/data" });
    host.drop(f, meaning);
    await settled();
    expect(deps.copy.open).toHaveBeenCalledWith(expect.objectContaining({ from: "a", to: "b", label: "title-web" }), "/data");
    expect(stores.requestMove).not.toHaveBeenCalled();
    cleanup();
  });

  it("from the desktop into a panel's folder it is sent at once, folders told apart", async () => {
    const { host, cleanup } = harness();
    const f = files(null, ["/Users/me/dir/", "/Users/me/x.txt"]);
    host.drop(f, { kind: "send", to: "b", dir: "/data" });
    await settled();
    expect(stores.startTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        destDir: "/data",
        sources: [
          { path: "/Users/me/dir/", isDir: true },
          { path: "/Users/me/x.txt", isDir: false },
        ],
      }),
    );
    cleanup();
  });

  it("onto a local terminal the paths are typed, quoted — and nothing when they cannot be", () => {
    const { host, deps, cleanup } = harness();
    host.drop(files(null, ["/Users/me/a b.txt"]), { kind: "paste", to: "l" });
    expect(deps.paste).toHaveBeenCalledWith("l", "'/Users/me/a b.txt' ");
    host.drop(files(null, ["/Users/me/line\nbreak"]), { kind: "paste", to: "l" });
    expect(deps.paste).toHaveBeenCalledTimes(1);
    expect(stores.notifyInfo).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("files held long enough open what they are over: the Files tab, or the tab", () => {
    const { host, cleanup } = harness();
    host.spring({ kind: "files" });
    host.spring({ kind: "tab", id: "b" });
    host.spring({ kind: "tab", id: "a" });
    expect(stores.revealPanel).toHaveBeenCalledWith("files");
    expect(stores.activateTab.mock.calls).toEqual([["b"]]);
    cleanup();
  });
});

describe("file drag flow: other windows and the system", () => {
  it("inside the window with no other one, the backend is not asked about held files", async () => {
    const { host, cleanup } = harness(false);
    expect(await host.over(files("a", ["/x"]))).toBeNull();
    expect(api.dragOver).not.toHaveBeenCalled();
    cleanup();
    const two = harness(true);
    await two.host.over(files("a", ["/x"]));
    expect(api.dragOver).toHaveBeenCalledTimes(1);
    two.cleanup();
  });

  it("every way a drag ends outside is said, so no window is left drawing files that are not coming", async () => {
    const { host, cleanup } = harness();
    api.dragDrop.mockResolvedValueOnce("win-2");
    host.release(files("a", ["/x"]));
    await settled();
    api.dragDrop.mockResolvedValueOnce(null);
    host.release(files("a", ["/x"]));
    await settled();
    api.dragDrop.mockRejectedValueOnce(new Error("gone"));
    host.release(files("a", ["/x"]));
    await settled();
    host.left();
    expect(api.dragEnd).toHaveBeenCalledTimes(4);
    cleanup();
  });

  it("files are handed to the system only when the model says they can be", async () => {
    const { host, cleanup } = harness();
    // Files of this machine stay the page's.
    expect(await host.out(files("l", ["/Users/me/x"]))).toBe(false);
    // A server's files go, named after their tab.
    expect(await host.out(files("a", ["/srv/x"]))).toBe(true);
    expect(api.dragOutBegin).toHaveBeenCalledTimes(1);
    expect(api.dragOutBegin).toHaveBeenCalledWith(expect.objectContaining({ session: "a", label: "title-web" }));
    cleanup();
    // A session that is down: not even asked.
    stores.tabs = stores.tabs.map((t) => (t.sessionId === "a" ? { ...t, status: "Disconnected" } : t));
    const down = harness();
    expect(await down.host.out(files("a", ["/srv/x"]))).toBe(false);
    expect(api.dragOutBegin).toHaveBeenCalledTimes(1);
    down.cleanup();
  });

  it("let go of outside every window: says why it was not carried, where a drop was plainly meant", async () => {
    const { host, cleanup } = harness();
    stores.tabs = stores.tabs.map((t) => (t.sessionId === "a" ? { ...t, status: "Disconnected" } : t));
    host.release(files("a", ["/srv/x"]));
    await settled();
    expect(stores.notifyInfo).toHaveBeenCalledTimes(1);
    // Files of this machine were never the system's to carry: nothing to say.
    host.release(files("l", ["/Users/me/x"]));
    await settled();
    expect(stores.notifyInfo).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("file drag flow: the desktop", () => {
  it("a drop lands under the pointer, in the page's pixels, through the target there", () => {
    const { flow, cleanup } = harness();
    const ratio = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    flow.heardDesktop({ type: "enter", paths: ["/Users/me/x.txt"], position: { x: 100, y: 60 } });
    expect(drag.showGuestFiles).toHaveBeenCalledWith(expect.objectContaining({ from: null }), 50, 30);
    flow.heardDesktop({ type: "drop", paths: ["/Users/me/x.txt"], position: { x: 200, y: 80 } });
    expect(drag.dropGuestFiles).toHaveBeenCalledWith(expect.objectContaining({ from: null }), 100, 40);
    expect(stores.startTransfer).not.toHaveBeenCalled();
    Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
    cleanup();
  });

  it("a drag that names no files is not the desktop's, and what it says clears nothing", () => {
    const { flow, cleanup } = harness();
    flow.heardDesktop({ type: "enter", paths: [], position: { x: 1, y: 1 } });
    flow.heardDesktop({ type: "over", position: { x: 2, y: 2 } });
    flow.heardDesktop({ type: "leave" });
    flow.heardDesktop({ type: "enter", paths: [], position: { x: 1, y: 1 } });
    flow.heardDesktop({ type: "drop", paths: [], position: { x: 1, y: 1 } });
    expect(drag.showGuestFiles).not.toHaveBeenCalled();
    expect(drag.clearGuestFiles).not.toHaveBeenCalled();
    // Named files that leave are taken off the window.
    flow.heardDesktop({ type: "enter", paths: ["/x"], position: { x: 1, y: 1 } });
    flow.heardDesktop({ type: "leave" });
    expect(drag.clearGuestFiles).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("files of another window are drawn, dropped and taken off as it says", () => {
    const { flow, cleanup } = harness();
    const f = files("x", ["/srv/x"]);
    flow.heardOtherWindow({ kind: "over", files: f, x: 3, y: 4 });
    flow.heardOtherWindow({ kind: "drop", files: f, x: 5, y: 6 });
    flow.heardOtherWindow({ kind: "leave" });
    expect(drag.showGuestFiles).toHaveBeenCalledWith(f, 3, 4);
    expect(drag.dropGuestFiles).toHaveBeenCalledWith(f, 5, 6);
    expect(drag.clearGuestFiles).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
