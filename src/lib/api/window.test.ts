import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const emit = vi.fn();
const windowListen = vi.fn();
const currentWindow = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: (...a: unknown[]) => emit(...a) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => currentWindow(),
}));

import * as api from "./window";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  emit.mockReset().mockResolvedValue(undefined);
  windowListen.mockReset().mockResolvedValue(() => {});
  currentWindow
    .mockReset()
    .mockReturnValue({ listen: (...a: unknown[]) => windowListen(...a) });
});

describe("window api", () => {
  it("listenHere subscribes on this window, not app-wide", async () => {
    const handler = vi.fn();
    const un = await api.listenHere("menu://settings", handler);
    expect(windowListen).toHaveBeenCalledWith("menu://settings", handler);
    expect(typeof un).toBe("function");
  });

  it("with no Tauri window to ask, the subscription is rejected — it does not throw", async () => {
    // The browser preview: asking for the current window throws. A synchronous
    // throw would abort the page's whole setup at its first subscription.
    currentWindow.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'metadata')");
    });
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = api.listenHere("menu://settings", vi.fn());
    }).not.toThrow();
    await expect(pending).rejects.toThrow(/metadata/);
  });

  it("event names mirror the backend's", () => {
    expect(api.WINDOW_CLOSE_EVENT).toBe("window://close");
    expect(api.CATALOG_EVENT).toBe("window://catalog");
    expect(api.SETTINGS_EVENT).toBe("window://settings");
    expect(api.SERVERS_DELETED_EVENT).toBe("window://servers-deleted");
  });

  it("what windows tell each other goes out as events", async () => {
    await api.broadcastSettings({ from: "main", json: "{}" });
    expect(emit).toHaveBeenCalledWith("window://settings", { from: "main", json: "{}" });
    await api.announceServersDeleted({ from: "win-2", ids: ["a", "b"] });
    expect(emit).toHaveBeenLastCalledWith("window://servers-deleted", {
      from: "win-2",
      ids: ["a", "b"],
    });
  });

  it("closing a window and its summary", async () => {
    await api.closeWindow();
    expect(invoke).toHaveBeenCalledWith("close_window");
    await api.reportWindowSummary([{ key: "ssh", count: 2 }]);
    expect(invoke).toHaveBeenLastCalledWith("report_window_summary", {
      rows: [{ key: "ssh", count: 2 }],
    });
    invoke.mockResolvedValue([{ key: "local", count: 1 }]);
    expect(await api.otherWindowsSummary()).toEqual([{ key: "local", count: 1 }]);
    expect(invoke).toHaveBeenLastCalledWith("other_windows_summary");
  });

  it("the handoff of a tab, step by step", async () => {
    invoke.mockResolvedValue(7);
    expect(await api.detachBegin("s1")).toBe(7);
    expect(invoke).toHaveBeenLastCalledWith("detach_begin", { sessionId: "s1" });

    invoke.mockResolvedValue("win-2");
    expect(await api.detachCommit("s1", "{}", { x: 10, y: 20, background: "#101010" })).toBe(
      "win-2",
    );
    expect(invoke).toHaveBeenLastCalledWith("detach_commit", {
      sessionId: "s1",
      packet: "{}",
      opts: { x: 10, y: 20, background: "#101010" },
    });

    await api.detachAbort("s1");
    expect(invoke).toHaveBeenLastCalledWith("detach_abort", { sessionId: "s1" });

    invoke.mockResolvedValue(null);
    expect(await api.takeHandoff()).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("take_handoff");

    await api.attachSession("s1");
    expect(invoke).toHaveBeenLastCalledWith("attach_session", { sessionId: "s1" });
  });
});
