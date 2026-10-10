// "Copy to session" in a file panel's row menu (v1.12). The panel knows nothing
// of the window's tabs: the page publishes where a file can be copied to, the
// panel offers those — never its own tab — and files a request the page shows.
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "./types";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

const files: FileEntry[] = ["a.conf", "b.conf"].map((name) => ({
  name, path: `/etc/${name}`, isDir: false, isSymlink: false, size: 1, modified: null,
  mode: null, uid: null, gid: null, user: null, group: null,
}));
vi.mock("./api", () => ({
  sftpHome: vi.fn(async () => "/etc"),
  sftpList: vi.fn(async () => files),
  localHome: vi.fn(async () => "/Users/me"),
  localList: vi.fn(async () => files),
  sftpMkdir: vi.fn(),
  sftpCreateFile: vi.fn(),
  sftpDelete: vi.fn(),
  sftpRename: vi.fn(),
  sftpCopy: vi.fn(),
  sftpCancel: vi.fn(),
  sftpGrep: vi.fn(),
  localMkdir: vi.fn(),
  localCreateFile: vi.fn(),
  localDelete: vi.fn(),
  localRename: vi.fn(),
  localCopy: vi.fn(),
  transferStart: vi.fn(),
  pickUploadFiles: vi.fn(),
  pickSavePath: vi.fn(),
  pickSaveDir: vi.fn(),
}));

import LocalFilePanel from "./LocalFilePanel.svelte";
import SftpPanel from "./SftpPanel.svelte";
import { resetDockState } from "./stores/dockstate.svelte";
import {
  fileSelectionOf,
  pendingCopyRequest,
  resetFileCopy,
  setCopyTargets,
} from "./stores/filecopy.svelte";

const settle = () => new Promise((r) => setTimeout(r, 30));
const targets = [
  { sessionId: "web", title: "web-01", local: false, prod: false },
  { sessionId: "db", title: "db-01", local: false, prod: true },
  { sessionId: "mine", title: "Local shell", local: true, prod: false },
];

beforeEach(() => {
  resetDockState();
  resetFileCopy();
});

async function sftpPanel() {
  const panel = render(SftpPanel, { props: { sessionId: "web", sessionReady: true, embedded: true } });
  await fireEvent.click(screen.getByText("Connect"));
  await settle();
  return panel;
}

const row = (name: string) => screen.getByText(name).closest('[role="treeitem"]') as HTMLElement;

describe("copy to another session, from a file panel's menu", () => {
  it("offers the other open sessions and files a request for the row", async () => {
    setCopyTargets(targets);
    await sftpPanel();
    await fireEvent.contextMenu(row("a.conf"));
    await fireEvent.click(screen.getByText("Copy to session"));
    // Its own tab is not somewhere to copy to.
    expect(screen.queryByText("web-01")).toBeNull();
    expect(screen.getByText("Local shell")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("db-01"));
    expect(pendingCopyRequest()).toMatchObject({
      from: "web",
      local: false,
      to: "db",
      entries: [{ path: "/etc/a.conf" }],
    });
  });

  it("copies the whole selection when the row is part of one", async () => {
    setCopyTargets(targets);
    await sftpPanel();
    await fireEvent.click(row("a.conf"));
    await fireEvent.click(row("b.conf"), { metaKey: true, ctrlKey: true });
    await fireEvent.contextMenu(row("b.conf"));
    await fireEvent.click(screen.getByText("Copy to session"));
    await fireEvent.click(screen.getByText("Local shell"));
    expect(pendingCopyRequest()?.entries.map((e) => e.name)).toEqual(["a.conf", "b.conf"]);
    expect(pendingCopyRequest()?.to).toBe("mine");
  });

  it("is not offered when there is nowhere to copy to", async () => {
    setCopyTargets([targets[0]]); // only this panel's own tab is open
    await sftpPanel();
    await fireEvent.contextMenu(row("a.conf"));
    expect(screen.queryByText("Copy to session")).toBeNull();
    expect(screen.getByText("Rename")).toBeInTheDocument();
  });

  it("a local tab's panel offers it too, and says its files are on this machine", async () => {
    setCopyTargets(targets);
    render(LocalFilePanel, { props: { sessionId: "mine", embedded: true } });
    await settle();
    await fireEvent.contextMenu(row("a.conf"));
    await fireEvent.click(screen.getByText("Copy to session"));
    expect(screen.queryByText("Local shell")).toBeNull();
    await fireEvent.click(screen.getByText("web-01"));
    expect(pendingCopyRequest()).toMatchObject({ from: "mine", local: true, to: "web" });
  });

  it("says what is selected in it while it is on screen — for the command palette", async () => {
    setCopyTargets(targets);
    const panel = await sftpPanel();
    expect(fileSelectionOf("web")).toBeNull();
    await fireEvent.click(row("a.conf"));
    await settle();
    expect(fileSelectionOf("web")).toMatchObject({ local: false, entries: [{ name: "a.conf" }] });
    // Hidden behind another dock tab, it takes its word back.
    await panel.rerender({ sessionId: "web", sessionReady: true, embedded: true, visible: false });
    await settle();
    expect(fileSelectionOf("web")).toBeNull();
  });
});
