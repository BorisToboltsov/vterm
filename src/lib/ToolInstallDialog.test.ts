import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolStatus } from "./servertools";

// Control the install call + capture the live-output listener so we can drive the
// streaming console deterministically.
const runToolInstall = vi.fn();
vi.mock("./api", () => ({
  runToolInstall: (...a: unknown[]) => runToolInstall(...a),
  installOutputEvent: (id: string) => `install://out/${id}`,
}));

let listenCb: ((e: { payload: string }) => void) | null = null;
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (e: { payload: string }) => void) => {
    listenCb = cb;
    return Promise.resolve(unlisten);
  },
}));

const notifySuccess = vi.fn();
const notifyError = vi.fn();
vi.mock("./stores/toasts.svelte", () => ({
  notifySuccess: (...a: unknown[]) => notifySuccess(...a),
  notifyError: (...a: unknown[]) => notifyError(...a),
}));

import ToolInstallDialog from "./ToolInstallDialog.svelte";

// A non-sudo tool (pip) so no password entry is required for the install path.
const tool: ToolStatus = {
  id: "ruff",
  name: "ruff",
  installed: false,
  command: "pip install ruff",
};

beforeEach(() => {
  vi.clearAllMocks();
  listenCb = null;
});

describe("ToolInstallDialog", () => {
  it("streams live output into the console and ends on a success state", async () => {
    let resolveInstall: (v: string) => void = () => {};
    runToolInstall.mockReturnValue(new Promise<string>((r) => (resolveInstall = r)));
    const onInstalled = vi.fn();

    render(ToolInstallDialog, {
      props: { open: true, sessionId: "s1", tool, onRunInTerminal: vi.fn(), onInstalled },
    });

    await userEvent.click(screen.getByText("Install via sudo"));

    // Progress indicator + console appear while the install runs.
    await waitFor(() => expect(screen.getByTestId("install-progress")).toBeInTheDocument());
    expect(runToolInstall).toHaveBeenCalledWith("s1", "pip install ruff", undefined);

    // A streamed chunk lands in the console.
    expect(listenCb).not.toBeNull();
    listenCb?.({ payload: "Collecting ruff\n" });
    await waitFor(() =>
      expect(screen.getByTestId("install-console").textContent).toContain("Collecting ruff"),
    );

    // Finishing shows success, refreshes the catalogue, and drops the listener.
    resolveInstall("done");
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    expect(notifySuccess).toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalled();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("surfaces an install failure as a toast without a success state", async () => {
    runToolInstall.mockRejectedValue("boom");
    render(ToolInstallDialog, {
      props: { open: true, sessionId: "s1", tool, onRunInTerminal: vi.fn() },
    });

    await userEvent.click(screen.getByText("Install via sudo"));
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith("boom"));
    expect(notifySuccess).not.toHaveBeenCalled();
    // Back to the actionable state (buttons restored).
    expect(screen.getByText("Install via sudo")).toBeInTheDocument();
  });
});
