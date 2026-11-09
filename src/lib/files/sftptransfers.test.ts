import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const sftpCancel = vi.fn(async () => {});
const transferResume = vi.fn(async (_id: string) => {});
const transferForget = vi.fn(async (_id: string) => {});
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  sftpList: vi.fn(async () => []),
  sftpHome: vi.fn(async () => "/home/me"),
  sftpCancel: (...a: unknown[]) => sftpCancel(...(a as [])),
  transferResume: (id: string) => transferResume(id),
  transferForget: (id: string) => transferForget(id),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import SftpPanel from "./SftpPanel.svelte";
import { applyProgress, clearTransfers, transfersState } from "../stores/transfers.svelte";
import { clearToasts, toastsState } from "../stores/toasts.svelte";

/** Mount the panel and press its Connect — the transfer list lives in the
 *  connected body. */
async function connected() {
  render(SftpPanel, { props: { embedded: true, sessionId: "s1", sessionReady: true } });
  await userEvent.click(screen.getByText(/connect/i));
  await new Promise((r) => setTimeout(r, 30));
}

const file = {
  name: "big.iso",
  direction: "download" as const,
  transferred: 10,
  total: 100,
};

describe("SftpPanel transfer rows", () => {
  afterEach(() => {
    clearTransfers();
    clearToasts();
    sftpCancel.mockClear();
    transferResume.mockReset();
    transferForget.mockClear();
  });

  it("a transfer cut off with something left offers to go on, and to be dropped (v1.36)", async () => {
    await connected();
    applyProgress({ ...file, id: "k1", done: true, sessions: ["s1"], resumable: "interrupted" });

    expect(await screen.findByTestId("transfer-kept")).toHaveTextContent("interrupted");
    // Nothing to stop: it is not moving.
    expect(screen.queryByTestId("transfer-cancel")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Continue the transfer" }));
    expect(transferResume).toHaveBeenCalledWith("k1");
    // Going on was refused (the session is down): said, and the row stays.
    transferResume.mockRejectedValueOnce(new Error("no session"));
    await userEvent.click(screen.getByTestId("transfer-resume"));
    await waitFor(() => expect(toastsState.list.map((t) => t.message)).toContain("Error: no session"));
    expect(transfersState.map.k1).toBeDefined();
    // Dropped: the row goes at once, and the backend takes the partial copy.
    await userEvent.click(screen.getByRole("button", { name: "Dismiss — the partial copy is deleted" }));
    expect(transferForget).toHaveBeenCalledWith("k1");
    expect(transfersState.map.k1).toBeUndefined();
  });

  it("a kept transfer whose files failed says so, not that it was cut off", async () => {
    await connected();
    applyProgress({ ...file, id: "k2", done: true, sessions: ["s1"], resumable: "failed" });
    expect(await screen.findByTestId("transfer-kept")).toHaveTextContent("not finished");
  });

  it("offers a visible stop on a single-file transfer, not only on folders", async () => {
    await connected();
    applyProgress({ ...file, id: "f1", done: false });

    const stop = await screen.findByTestId("transfer-cancel");
    // Not hover-only: the control is laid out whether or not the row is hovered.
    expect(stop).not.toHaveClass("hidden");
    await userEvent.click(stop);
    expect(sftpCancel).toHaveBeenCalledWith("f1");
  });

  it("has nothing to stop on a finished transfer or a sync-run file", async () => {
    await connected();
    applyProgress({ ...file, id: "f2", done: true });
    applyProgress({ ...file, id: "sync:a/big.iso", done: false });

    expect(await screen.findAllByText("big.iso")).toHaveLength(2);
    expect(screen.queryByTestId("transfer-cancel")).toBeNull();
  });

  it("keeps Upload visible and moves less-used actions into More at dock minimum width", async () => {
    await connected();
    const toolbar = screen.getByTestId("sftp-toolbar");
    Object.defineProperty(toolbar, "clientWidth", { configurable: true, value: 240 });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const observer of observers) observer.cb([{ target: toolbar }]);

    const more = await screen.findByTestId("sftp-toolbar-more");
    expect(within(toolbar).getByRole("button", { name: "Upload" })).toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: "New folder" })).toBeNull();
    await userEvent.click(more);
    expect(screen.getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "New file" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sync folder" })).toBeInTheDocument();

    Object.defineProperty(toolbar, "clientWidth", { configurable: true, value: 384 });
    for (const observer of observers) observer.cb([{ target: toolbar }]);
    await waitFor(() => expect(screen.queryByTestId("sftp-toolbar-more")).toBeNull());
    expect(within(toolbar).getByRole("button", { name: "Upload" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "New folder" })).toBeInTheDocument();
  });
});
