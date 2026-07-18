// The Windows "This PC" level in the local file panel (Phase 39.1).
//
// Phase 39 hid the ".." row at `C:\` because following it printed `/` in the path
// bar. That fixed the lie but closed the only door: the path bar is read-only
// text, so with no ".." there was no way whatsoever to reach `D:`. These tests pin
// the round trip — up from a drive root to the drive list, and back down into a
// different drive — plus the guards that keep the synthetic level read-only.

import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "./types";

const localList = vi.fn();
const localHome = vi.fn();
const localMkdir = vi.fn();
const localCreateFile = vi.fn();
vi.mock("./api", () => ({
  localList: (...a: unknown[]) => localList(...a),
  localHome: (...a: unknown[]) => localHome(...a),
  localMkdir: (...a: unknown[]) => localMkdir(...a),
  localCreateFile: (...a: unknown[]) => localCreateFile(...a),
  localDelete: vi.fn(),
  localRename: vi.fn(),
  localCopy: vi.fn(),
}));

import LocalFilePanel from "./LocalFilePanel.svelte";
import { DRIVES_ROOT } from "./fspath";

const GB = 1024 ** 3;

const driveEntry = (
  letter: string,
  over: Partial<FileEntry["drive"] & object> = {},
): FileEntry => ({
  name: `${letter}:`,
  path: `${letter}:\\`,
  isDir: true,
  isSymlink: false,
  size: 0,
  modified: null,
  mode: null,
  uid: null,
  gid: null,
  user: null,
  group: null,
  drive: { label: "", kind: "fixed", free: null, total: null, ...over },
});

const dirEntry = (name: string, path: string): FileEntry => ({
  ...fileEntry(name, path),
  isDir: true,
  size: 0,
});

const fileEntry = (name: string, path: string): FileEntry => ({
  name,
  path,
  isDir: false,
  isSymlink: false,
  size: 10,
  modified: null,
  mode: null,
  uid: null,
  gid: null,
  user: null,
  group: null,
});

/** Route `localList` by path so navigation can be followed end to end. */
function route(map: Record<string, FileEntry[]>) {
  localList.mockImplementation((p: string) => Promise.resolve(map[p] ?? []));
}

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  localList.mockReset().mockResolvedValue([]);
  localHome.mockReset().mockResolvedValue("C:\\Users\\me");
  localMkdir.mockReset();
  localCreateFile.mockReset();
});

describe("LocalFilePanel — Windows drives level", () => {
  it("offers '..' at a drive root and navigates to the drive list", async () => {
    route({
      "C:\\": [fileEntry("boot.ini", "C:\\boot.ini")],
      [DRIVES_ROOT]: [driveEntry("C"), driveEntry("D")],
    });
    localHome.mockResolvedValue("C:\\");
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    // The ".." row exists at C:\ — Phase 39 had removed it entirely.
    const up = screen.getByLabelText("Go up one level");
    await fireEvent.dblClick(up);
    await settle();

    expect(localList).toHaveBeenCalledWith(DRIVES_ROOT);
  });

  it("lets the user descend into a different drive from the list", async () => {
    route({
      [DRIVES_ROOT]: [driveEntry("C"), driveEntry("D")],
      "D:\\": [fileEntry("data.txt", "D:\\data.txt")],
    });
    localHome.mockResolvedValue(DRIVES_ROOT);
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();

    // This is the whole point of the feature: D: is reachable again.
    await fireEvent.dblClick(screen.getByText("D:"));
    await settle();
    expect(localList).toHaveBeenCalledWith("D:\\");
  });

  it("has no '..' at the drives level itself", async () => {
    route({ [DRIVES_ROOT]: [driveEntry("C")] });
    localHome.mockResolvedValue(DRIVES_ROOT);
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();
    expect(screen.queryByLabelText("Go up one level")).toBeNull();
  });

  it("shows the volume label and free space like Explorer", async () => {
    route({
      [DRIVES_ROOT]: [
        driveEntry("C", { label: "Windows", free: 120 * GB, total: 500 * GB }),
      ],
    });
    localHome.mockResolvedValue(DRIVES_ROOT);
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();
    expect(screen.getByText("Windows (C:)")).toBeInTheDocument();
    expect(screen.getByText(/free of/)).toBeInTheDocument();
  });

  // Network/optical drives are listed but never probed (a stale SMB mount blocks
  // for seconds), so they must fall back to naming their kind.
  it("names the kind for a drive with no size data", async () => {
    route({
      [DRIVES_ROOT]: [driveEntry("Z", { kind: "remote", free: null, total: null })],
    });
    localHome.mockResolvedValue(DRIVES_ROOT);
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();
    expect(screen.getByText("Z:")).toBeInTheDocument();
    expect(screen.getByText("Network drive")).toBeInTheDocument();
    expect(screen.queryByText(/free of/)).toBeNull();
  });

  it("names the level instead of leaking the sentinel into the path bar", async () => {
    route({ [DRIVES_ROOT]: [driveEntry("C")] });
    localHome.mockResolvedValue(DRIVES_ROOT);
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();
    expect(screen.getByText("This PC")).toBeInTheDocument();
    expect(screen.queryByText(DRIVES_ROOT)).toBeNull();
  });

  // "Create a folder in This PC" is not an offer we make; the level is synthetic.
  it("disables creating files and folders at the drives level", async () => {
    route({ [DRIVES_ROOT]: [driveEntry("C")] });
    localHome.mockResolvedValue(DRIVES_ROOT);
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();
    expect(screen.getByLabelText("New folder")).toBeDisabled();
    expect(screen.getByLabelText("New file")).toBeDisabled();
  });

  it("keeps create enabled inside a real directory", async () => {
    route({ "C:\\Users\\me": [] });
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();
    expect(screen.getByLabelText("New folder")).not.toBeDisabled();
    expect(screen.getByLabelText("New file")).not.toBeDisabled();
  });

  // POSIX must be untouched: "/" is genuinely the top, with no synthetic level.
  it("still hides '..' at POSIX root", async () => {
    route({ "/": [fileEntry("etc", "/etc")] });
    localHome.mockResolvedValue("/");
    render(LocalFilePanel, { props: { embedded: true } });
    await settle();
    expect(screen.queryByLabelText("Go up one level")).toBeNull();
  });
});

// ── Two-way follow (Phase 39.4) ──────────────────────────────────────────────
// SFTP has had this since Phase 29: navigating in the panel cd's the terminal to
// match. Local tabs didn't, so the panel and the shell drifted apart the moment
// you clicked a folder.

describe("LocalFilePanel — two-way follow", () => {
  // This file's default home is a Windows path; these cases are POSIX-shaped.
  beforeEach(() => {
    localHome.mockResolvedValue("/home/me");
  });

  it("reports a folder the user opened so the page can cd the terminal", async () => {
    route({ "/home/me": [dirEntry("work", "/home/me/work")], "/home/me/work": [] });
    const onUserNavigate = vi.fn();
    render(LocalFilePanel, {
      props: { embedded: true, followTerminal: true, onUserNavigate },
    });
    await settle();

    await fireEvent.dblClick(screen.getByText("work"));
    await settle();
    expect(onUserNavigate).toHaveBeenCalledWith("/home/me/work");
  });

  it("reports going up a level", async () => {
    route({ "/home/me": [], "/home": [] });
    const onUserNavigate = vi.fn();
    render(LocalFilePanel, {
      props: { embedded: true, followTerminal: true, onUserNavigate },
    });
    await settle();

    await fireEvent.dblClick(screen.getByLabelText("Go up one level"));
    await settle();
    expect(onUserNavigate).toHaveBeenCalledWith("/home");
  });

  // The whole point of gating on the toggle: without it, the panel would cd the
  // shell even when the user never asked the two to be linked.
  it("stays silent while following is off", async () => {
    route({ "/home/me": [dirEntry("work", "/home/me/work")], "/home/me/work": [] });
    const onUserNavigate = vi.fn();
    render(LocalFilePanel, {
      props: { embedded: true, followTerminal: false, onUserNavigate },
    });
    await settle();

    await fireEvent.dblClick(screen.getByText("work"));
    await settle();
    expect(onUserNavigate).not.toHaveBeenCalled();
  });

  // Feedback-loop guard: the panel moving *because the terminal moved* must not
  // cd the terminal back, or the two would ping-pong.
  it("does not report a move it made by following the terminal", async () => {
    route({ "/home/me": [], "/var/log": [] });
    const onUserNavigate = vi.fn();
    const { rerender } = render(LocalFilePanel, {
      props: { embedded: true, followTerminal: true, terminalCwd: null, onUserNavigate },
    });
    await settle();
    onUserNavigate.mockClear();

    await rerender({
      embedded: true,
      followTerminal: true,
      terminalCwd: "/var/log",
      onUserNavigate,
    });
    await settle();

    expect(localList).toHaveBeenCalledWith("/var/log"); // it did follow…
    expect(onUserNavigate).not.toHaveBeenCalled(); // …but stayed silent
  });

  // "cd into This PC" is meaningless — there is no directory for a shell to enter.
  it("never asks the terminal to cd into the synthetic drives level", async () => {
    route({ "C:\\": [], [DRIVES_ROOT]: [driveEntry("C")] });
    localHome.mockResolvedValue("C:\\");
    const onUserNavigate = vi.fn();
    render(LocalFilePanel, {
      props: { embedded: true, followTerminal: true, onUserNavigate },
    });
    await settle();

    await fireEvent.dblClick(screen.getByLabelText("Go up one level"));
    await settle();
    expect(localList).toHaveBeenCalledWith(DRIVES_ROOT); // the panel went up…
    expect(onUserNavigate).not.toHaveBeenCalled(); // …without cd-ing the shell
  });
});
