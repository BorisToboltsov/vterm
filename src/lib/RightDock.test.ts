import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sftpList: vi.fn(async () => []),
  sftpHome: vi.fn(async () => "/home/me"),
  localList: vi.fn(async () => []),
  localHome: vi.fn(async () => "/Users/me"),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import RightDock from "./RightDock.svelte";

const base = { sessionId: "s1", activeTab: "files" as const };

describe("RightDock connection state", () => {
  it("replaces the panels with one notice when the SSH session is gone", () => {
    render(RightDock, { props: { ...base, kind: "ssh", connection: "offline" } });
    expect(screen.getByTestId("dock-offline")).toBeInTheDocument();
    expect(screen.getByText("No connection to the server")).toBeInTheDocument();
    // The SFTP panel stays mounted (its state survives the reconnect) but hidden,
    // so its follow-terminal toggle is not offered on a dead session.
    const pane = screen.getByTestId("dock-offline").nextElementSibling;
    expect(pane).toHaveClass("hidden");
  });

  it("shows the panel, not the notice, while connected", () => {
    render(RightDock, { props: { ...base, kind: "ssh", connection: "connected" } });
    expect(screen.queryByTestId("dock-offline")).toBeNull();
  });

  it("keeps the panel (not the notice) while still connecting", () => {
    render(RightDock, { props: { ...base, kind: "ssh", connection: "connecting" } });
    expect(screen.queryByTestId("dock-offline")).toBeNull();
  });

  it("says the shell exited for a local tab", () => {
    render(RightDock, { props: { ...base, kind: "local", connection: "offline" } });
    expect(screen.getByText("The shell has exited")).toBeInTheDocument();
  });
});
