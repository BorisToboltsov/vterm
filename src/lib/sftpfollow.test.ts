import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const sftpList = vi.fn();
const sftpHome = vi.fn();
sftpList.mockResolvedValue([]);
sftpHome.mockResolvedValue("/home/me");
vi.mock("./api", () => ({
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
