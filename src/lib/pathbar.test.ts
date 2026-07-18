// Click-to-edit path bar in the file panels (Phase 39.2).
//
// Until now the path was read-only text, so the only way to reach a directory was
// to click down through the tree — which is how Phase 39 managed to make `D:`
// completely unreachable on Windows by hiding one ".." row. A typed path is the
// direct route that was missing, and it is also the escape hatch when navigation
// itself is broken.

import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "./types";

// SftpPanel subscribes to the webview's drag-drop events on mount; without this
// the unmocked Tauri API throws asynchronously and Vitest reports unhandled
// errors that can mask real failures.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

const localList = vi.fn();
const localHome = vi.fn();
vi.mock("./api", () => ({
  localList: (...a: unknown[]) => localList(...a),
  localHome: (...a: unknown[]) => localHome(...a),
  localMkdir: vi.fn(),
  localCreateFile: vi.fn(),
  localDelete: vi.fn(),
  localRename: vi.fn(),
  localCopy: vi.fn(),
  // SFTP surface (the panel is exercised at the bottom of this file).
  sftpHome: vi.fn(),
  sftpList: vi.fn(),
  sftpMkdir: vi.fn(),
  sftpCreateFile: vi.fn(),
  sftpDelete: vi.fn(),
  sftpRename: vi.fn(),
  sftpCopy: vi.fn(),
  sftpUpload: vi.fn(),
  sftpDownload: vi.fn(),
  sftpCancelTransfer: vi.fn(),
  grepRemote: vi.fn(),
}));

import LocalFilePanel from "./LocalFilePanel.svelte";

const dir = (name: string, path: string): FileEntry => ({
  name,
  path,
  isDir: true,
  isSymlink: false,
  size: 0,
  modified: null,
  mode: null,
  uid: null,
  gid: null,
  user: null,
  group: null,
});

const settle = () => new Promise((r) => setTimeout(r, 30));

/** Open the path editor and return the input. */
async function openEditor() {
  await fireEvent.click(screen.getByTestId("path-bar"));
  await settle();
  return screen.getByTestId("path-input") as HTMLInputElement;
}

beforeEach(() => {
  localList.mockReset().mockResolvedValue([dir("sub", "/home/me/sub")]);
  localHome.mockReset().mockResolvedValue("/home/me");
});

describe("path bar — editing", () => {
  it("pre-fills the current path and navigates on Enter", async () => {
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    const input = await openEditor();
    expect(input.value).toBe("/home/me");

    localList.mockClear();
    await fireEvent.input(input, { target: { value: "/etc/nginx" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(localList).toHaveBeenCalledWith("/etc/nginx");
    // Editor closes and the bar comes back showing where we landed.
    expect(screen.queryByTestId("path-input")).toBeNull();
    expect(screen.getByTestId("path-bar")).toHaveTextContent("/etc/nginx");
  });

  it("cancels on Escape without navigating", async () => {
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    const input = await openEditor();
    localList.mockClear();
    await fireEvent.input(input, { target: { value: "/somewhere/else" } });
    await fireEvent.keyDown(input, { key: "Escape" });
    await settle();

    expect(localList).not.toHaveBeenCalled();
    expect(screen.queryByTestId("path-input")).toBeNull();
    expect(screen.getByTestId("path-bar")).toHaveTextContent("/home/me");
  });

  it("cancels on blur, so clicking away doesn't navigate somewhere half-typed", async () => {
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    const input = await openEditor();
    localList.mockClear();
    await fireEvent.input(input, { target: { value: "/half-typed" } });
    await fireEvent.blur(input);
    await settle();

    expect(localList).not.toHaveBeenCalled();
    expect(screen.queryByTestId("path-input")).toBeNull();
  });

  it("does nothing for empty input or the path we are already in", async () => {
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    let input = await openEditor();
    localList.mockClear();
    await fireEvent.input(input, { target: { value: "   " } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    expect(localList).not.toHaveBeenCalled();

    input = await openEditor();
    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    expect(localList).not.toHaveBeenCalled();
  });

  // The realistic Windows paste: Explorer's "Copy as path" adds double quotes.
  it("accepts a quoted path pasted from Explorer", async () => {
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    const input = await openEditor();
    localList.mockClear();
    await fireEvent.input(input, { target: { value: '"C:\\Program Files"' } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(localList).toHaveBeenCalledWith("C:\\Program Files");
  });

  it("expands ~ against the home the panel started from", async () => {
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    const input = await openEditor();
    localList.mockClear();
    await fireEvent.input(input, { target: { value: "~/.ssh" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(localList).toHaveBeenCalledWith("/home/me/.ssh");
  });

  // A bad path must surface as an inline error, not a silent no-op — this is the
  // panel's existing load-failure path, reached through typed input.
  it("shows the load error for a path that does not exist", async () => {
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    const input = await openEditor();
    localList.mockRejectedValueOnce("read_dir /nope: No such file or directory");
    await fireEvent.input(input, { target: { value: "/nope" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(screen.getByText(/No such file or directory/)).toBeInTheDocument();
  });

  // On Windows this is the whole point: typing a drive gets you there directly,
  // without relying on the ".." row at all.
  it("reaches another drive by typing a bare drive letter", async () => {
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    const input = await openEditor();
    localList.mockClear();
    await fireEvent.input(input, { target: { value: "D:" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(localList).toHaveBeenCalledWith("D:\\");
  });
});

// ── SFTP panel: same bar, plus the OSC 7 mirror ──────────────────────────────
// A typed path is a user-initiated move, so while "follow terminal" is on it must
// `cd` the terminal too — exactly like clicking a folder does. Without this the
// panel and the shell would silently drift apart.

import SftpPanel from "./SftpPanel.svelte";
import { sftpHome, sftpList } from "./api";

async function connectSftp(onUserNavigate?: (p: string) => void) {
  render(SftpPanel, {
    props: {
      sessionId: "s1",
      sessionReady: true,
      embedded: true,
      followTerminal: true,
      onUserNavigate,
    },
  });
  await fireEvent.click(screen.getByText("Connect"));
  await settle();
}

describe("path bar — SFTP panel", () => {
  beforeEach(() => {
    vi.mocked(sftpHome).mockReset().mockResolvedValue("/home/remote");
    vi.mocked(sftpList).mockReset().mockResolvedValue([]);
  });

  it("navigates to a typed path and mirrors it into the terminal", async () => {
    const onUserNavigate = vi.fn();
    await connectSftp(onUserNavigate);

    const input = await openEditor();
    expect(input.value).toBe("/home/remote");

    vi.mocked(sftpList).mockClear();
    await fireEvent.input(input, { target: { value: "/var/log" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(vi.mocked(sftpList)).toHaveBeenCalledWith("s1", "/var/log");
    expect(onUserNavigate).toHaveBeenCalledWith("/var/log");
  });

  it("does not touch the terminal when the edit is cancelled", async () => {
    const onUserNavigate = vi.fn();
    await connectSftp(onUserNavigate);

    const input = await openEditor();
    await fireEvent.input(input, { target: { value: "/var/log" } });
    await fireEvent.keyDown(input, { key: "Escape" });
    await settle();

    expect(onUserNavigate).not.toHaveBeenCalled();
  });
});
