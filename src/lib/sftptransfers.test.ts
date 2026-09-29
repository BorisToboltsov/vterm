import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const sftpCancel = vi.fn(async () => {});
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sftpList: vi.fn(async () => []),
  sftpHome: vi.fn(async () => "/home/me"),
  sftpCancel: (...a: unknown[]) => sftpCancel(...(a as [])),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import SftpPanel from "./SftpPanel.svelte";
import { applyProgress, clearTransfers } from "./stores/transfers.svelte";

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
  isFolder: false,
};

describe("SftpPanel transfer rows", () => {
  afterEach(() => {
    clearTransfers();
    sftpCancel.mockClear();
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
});
