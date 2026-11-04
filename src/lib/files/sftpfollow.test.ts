import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const sftpList = vi.fn();
const sftpHome = vi.fn();
sftpList.mockResolvedValue([]);
sftpHome.mockResolvedValue("/home/me");
vi.mock("../api", () => ({
  shellUser: vi.fn(async () => null),
  onSessionSubmit: vi.fn(() => () => {}),
  sftpList: (...a: unknown[]) => sftpList(...a),
  sftpHome: (...a: unknown[]) => sftpHome(...a),
  sftpConnect: vi.fn(async () => {}),
  sftpMkdir: vi.fn(),
  sftpCreateFile: vi.fn(),
  sftpDelete: vi.fn(),
  sftpUpload: vi.fn(),
  sftpDownload: vi.fn(),
  grepRemote: vi.fn(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import SftpPanel from "./SftpPanel.svelte";
import { requestFilesDir } from "../stores/dockstate.svelte";

describe("SftpPanel follow-terminal", () => {
  it("navigates to a new terminalCwd once connected + following", async () => {
    const { rerender } = render(SftpPanel, {
      props: { embedded: true, sessionId: "s1", sessionReady: true, followTerminal: true, terminalCwd: null },
    });
    // Connect (sets connected = true, loads home).
    await userEvent.click(screen.getByText(/connect/i));
    await new Promise((r) => setTimeout(r, 30));
    sftpList.mockClear();
    // A cd in the terminal arrives:
    await rerender({ embedded: true, sessionId: "s1", sessionReady: true, followTerminal: true, terminalCwd: "/var/log" });
    await new Promise((r) => setTimeout(r, 30));
    expect(sftpList).toHaveBeenCalledWith("s1", "/var/log");
  });
});

describe("SftpPanel: a folder clicked in terminal output", () => {
  const props = (over: Record<string, unknown> = {}) => ({
    embedded: true,
    sessionReady: true,
    sessionId: `s-${Math.random()}`,
    onUserNavigate: vi.fn(),
    ...over,
  });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  async function connectedPanel(over: Record<string, unknown> = {}) {
    const p = props(over);
    render(SftpPanel, { props: p });
    await userEvent.click(screen.getByText(/connect/i));
    await settle();
    sftpList.mockClear();
    return p;
  }

  it("moves the terminal too while following, once the folder opened", async () => {
    const p = await connectedPanel({ followTerminal: true });
    p.onUserNavigate.mockClear();
    requestFilesDir(p.sessionId, "/var/log");
    await settle();
    expect(sftpList).toHaveBeenCalledWith(p.sessionId, "/var/log");
    expect(p.onUserNavigate.mock.calls).toEqual([["/var/log"]]);
  });

  it("leaves the terminal alone while not following", async () => {
    const p = await connectedPanel({ followTerminal: false });
    requestFilesDir(p.sessionId, "/var/log");
    await settle();
    expect(sftpList).toHaveBeenCalledWith(p.sessionId, "/var/log");
    expect(p.onUserNavigate).not.toHaveBeenCalled();
  });

  it("types nothing into the shell over a folder that refused", async () => {
    const p = await connectedPanel({ followTerminal: true });
    p.onUserNavigate.mockClear();
    sftpList.mockRejectedValueOnce("permission denied");
    requestFilesDir(p.sessionId, "/root");
    await settle();
    expect(p.onUserNavigate).not.toHaveBeenCalled();
  });

  it("a panel not connected yet connects to the folder, and the terminal goes there too", async () => {
    const p = props({ followTerminal: true });
    requestFilesDir(p.sessionId, "/srv/app");
    render(SftpPanel, { props: p });
    await settle();
    expect(sftpList).toHaveBeenCalledWith(p.sessionId, "/srv/app");
    expect(p.onUserNavigate.mock.calls).toEqual([["/srv/app"]]);
  });
});
