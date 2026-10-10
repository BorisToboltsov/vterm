// A file panel and dragged files (v1.13). The panel says what is picked up and
// marks what can be dropped on; the drag itself is the store's — a session's
// panel is destroyed whenever its tab stops being on screen, and files held over
// another tab put that tab on screen.
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "./types";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => {
    throw new Error("a file panel listens for no window-wide drop");
  },
}));

const entry = (name: string, isDir = false): FileEntry => ({
  name, path: `/srv/${name}`, isDir, isSymlink: false, size: 1, modified: null,
  mode: null, uid: null, gid: null, user: null, group: null,
});
const listing = [entry("backup", true), entry("a.conf"), entry("b.conf")];
const sftpRename = vi.fn();
vi.mock("./api", () => ({
  sftpHome: vi.fn(async () => "/srv"),
  sftpList: vi.fn(async () => listing),
  sftpMkdir: vi.fn(),
  sftpCreateFile: vi.fn(),
  sftpDelete: vi.fn(),
  sftpRename: (...a: unknown[]) => sftpRename(...a),
  sftpCopy: vi.fn(),
  sftpCancel: vi.fn(),
  sftpGrep: vi.fn(),
  transferStart: vi.fn(),
  localList: vi.fn(async () => []),
  pickUploadFiles: vi.fn(),
  pickSavePath: vi.fn(),
  pickSaveDir: vi.fn(),
}));

import SftpPanel from "./SftpPanel.svelte";
import { resetDockState } from "./stores/dockstate.svelte";
import { requestMove, resetFileCopy } from "./stores/filecopy.svelte";
import {
  cancelFileDrag,
  clearGuestFiles,
  fileDrag,
  onFileDrag,
  showGuestFiles,
} from "./stores/filedrag.svelte";

const settle = () => new Promise((r) => setTimeout(r, 30));
const row = (name: string) => screen.getByText(name).closest('[role="treeitem"]') as HTMLElement;
const at = (el: Element | null) => (document.elementFromPoint = () => el);
const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, button: 0, bubbles: true });

async function panel(sessionId = "web") {
  const view = render(SftpPanel, { props: { sessionId, sessionReady: true, embedded: true } });
  await fireEvent.click(screen.getByText("Connect"));
  await settle();
  return view;
}

/** Press a row and move far enough for it to be a drag. */
async function pickUp(name: string) {
  const el = row(name);
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  await fireEvent(el, pointer("pointerdown", 10, 10));
  window.dispatchEvent(pointer("pointermove", 60, 60));
  await settle();
}

beforeEach(() => {
  resetDockState();
  resetFileCopy();
  cancelFileDrag();
  sftpRename.mockReset().mockResolvedValue(undefined);
  // Every target means something: this file is about the panel, not the rules.
  onFileDrag({
    meaning: (_f, target) => ({ kind: "copy", to: target.session, dir: null }),
    drop: vi.fn(),
    spring: vi.fn(),
  });
  at(null);
});
afterEach(() => {
  cancelFileDrag();
  clearGuestFiles();
  onFileDrag(null);
});

describe("what a file panel puts in the air", () => {
  it("the row that was pressed — from this session, on its server", async () => {
    await panel();
    await pickUp("a.conf");
    expect(fileDrag.files).toEqual({
      from: "web",
      local: false,
      label: "",
      entries: [{ path: "/srv/a.conf", name: "a.conf", isDir: false }],
    });
    expect(fileDrag.guest).toBe(false);
  });

  it("the whole selection, when the pressed row is part of it", async () => {
    await panel();
    await fireEvent.click(row("a.conf"));
    await fireEvent.click(row("b.conf"), { metaKey: true, ctrlKey: true });
    await pickUp("b.conf");
    expect(fileDrag.files?.entries.map((e) => e.name)).toEqual(["a.conf", "b.conf"]);
  });

  it("a row outside the selection becomes the selection", async () => {
    await panel();
    await fireEvent.click(row("a.conf"));
    await pickUp("backup");
    expect(fileDrag.files?.entries).toEqual([{ path: "/srv/backup", name: "backup", isDir: true }]);
  });

  it("nothing from a press on a row's own buttons", async () => {
    await panel();
    const button = row("a.conf").querySelector("[data-nodrag]") as HTMLElement;
    await fireEvent(button, pointer("pointerdown", 10, 10));
    window.dispatchEvent(pointer("pointermove", 60, 60));
    expect(fileDrag.files).toBeNull();
  });
});

describe("what a file panel offers to drop on", () => {
  it("marks itself, the folder it shows and its folder rows", async () => {
    await panel();
    const root = document.querySelector("[data-file-panel]") as HTMLElement;
    expect(root.dataset.filePanel).toBe("web");
    expect((root.querySelector("[data-file-cwd]") as HTMLElement).dataset.fileCwd).toBe("/srv");
    expect(row("backup").dataset.drop).toBe("/srv/backup");
    // A file is not somewhere to drop into.
    expect(row("a.conf").dataset.drop).toBeUndefined();
  });

  it("a panel that lists nothing yet offers no folder — only itself", () => {
    render(SftpPanel, { props: { sessionId: "web", sessionReady: true, embedded: true } });
    const root = document.querySelector("[data-file-panel]") as HTMLElement;
    expect(root.dataset.filePanel).toBe("web");
    expect(root.querySelector("[data-file-cwd]")).toBeNull();
  });

  it("shows which folder the files in the air would land in", async () => {
    await panel("db");
    const guest = {
      from: "web",
      local: false,
      label: "web-01",
      entries: [{ path: "/etc/x", name: "x", isDir: false }],
    };
    at(row("backup"));
    showGuestFiles(guest, 5, 5);
    await settle();
    expect(row("backup").className).toMatch(/ring-accent|bg-accent/);
    expect(document.querySelector("[data-file-panel]")!.className).not.toMatch(/ring-2/);
    // Over the list itself — the folder the panel shows — the panel is ringed.
    at(document.querySelector("[data-file-cwd]"));
    showGuestFiles(guest, 6, 6);
    await settle();
    expect(document.querySelector("[data-file-panel]")!.className).toMatch(/ring-2 ring-inset ring-accent/);
    clearGuestFiles();
    await settle();
    expect(document.querySelector("[data-file-panel]")!.className).not.toMatch(/ring-2/);
  });
});

describe("rows let go of over a folder of their own panel", () => {
  it("are asked about, then moved — by whichever panel shows that session now", async () => {
    // The panel the drag began in is gone; a new one shows the session.
    const first = await panel();
    first.unmount();
    // It comes back connected and in the same folder: there is no Connect to press.
    render(SftpPanel, { props: { sessionId: "web", sessionReady: true, embedded: true } });
    await settle();
    requestMove({ session: "web", paths: ["/srv/a.conf", "/srv/b.conf"], dir: "/srv/backup" });
    await settle();
    expect(screen.getByText("Move?")).toBeInTheDocument();
    expect(screen.getByText(/Move 2 selected items to “\/srv\/backup”/)).toBeInTheDocument();
    expect(sftpRename).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByText("Move"));
    await settle();
    expect(sftpRename.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["/srv/a.conf", "/srv/backup/a.conf"],
      ["/srv/b.conf", "/srv/backup/b.conf"],
    ]);
  });

  it("a request for another session's panel is not this one's", async () => {
    await panel("web");
    requestMove({ session: "db", paths: ["/srv/a.conf"], dir: "/srv/backup" });
    await settle();
    expect(screen.queryByText("Move?")).toBeNull();
  });

  it("a folder is not moved into itself, and nothing into where it already is", async () => {
    await panel();
    requestMove({ session: "web", paths: ["/srv/backup"], dir: "/srv/backup" });
    await settle();
    expect(screen.queryByText("Move?")).toBeNull();
    requestMove({ session: "web", paths: ["/srv/a.conf"], dir: "/srv" });
    await settle();
    expect(screen.queryByText("Move?")).toBeNull();
  });
});
