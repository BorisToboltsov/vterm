import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dialog talks to the backend only through these; each test drives them.
const hoisted = vi.hoisted(() => ({
  localHashTree: vi.fn(),
  sftpHashTree: vi.fn(),
  sftpSyncApply: vi.fn(),
  sftpCancel: vi.fn(),
  pickSaveDir: vi.fn(),
}));

vi.mock("./api", () => hoisted);

import SyncModal from "./SyncModal.svelte";
import { applySyncProgress, clearSyncRun } from "./stores/syncrun.svelte";
import { clearToasts } from "./stores/toasts.svelte";
import type { SftpProgress } from "./api";

const progress = (path: string, transferred: number, total: number, done = false): SftpProgress => ({
  id: `sync:${path}`,
  name: path,
  direction: "upload",
  transferred,
  total,
  done,
  isFolder: false,
});

/** Render with a local folder chosen and a plan already compared. */
async function openWithPlan() {
  hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
  // Local has two files the remote lacks → two uploads.
  hoisted.localHashTree.mockResolvedValue([
    { path: "a.txt", sha256: "1" },
    { path: "b.txt", sha256: "2" },
  ]);
  hoisted.sftpHashTree.mockResolvedValue([]);
  render(SyncModal, {
    props: { open: true, sessionId: "sess", remotePath: "/srv/app", onclose: vi.fn() },
  });
  await fireEvent.click(screen.getByRole("button", { name: /Choose/ }));
  await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  await screen.findByTitle("a.txt");
}

describe("SyncModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncRun();
    clearToasts();
  });

  it("shows per-row progress while a run is in flight", async () => {
    // Hold the run open so the dialog stays in its "running" phase.
    let finish: (v: unknown) => void = () => {};
    hoisted.sftpSyncApply.mockReturnValue(new Promise((r) => (finish = r)));
    await openWithPlan();

    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    applySyncProgress(progress("a.txt", 10, 10, true));
    applySyncProgress(progress("b.txt", 3, 12));

    // Finished row ticked, in-flight row shows its own percent, header rolls up.
    await waitFor(() => expect(screen.getByLabelText("done")).toBeTruthy());
    expect(screen.getByText("25%")).toBeTruthy(); // b.txt: 3 of 12
    expect(screen.getByText("File 1 of 2")).toBeTruthy();

    finish({ uploaded: 2, downloaded: 0, deleted: 0, stopped: false });
  });

  it("cancels the run it started, by its own run id", async () => {
    hoisted.sftpSyncApply.mockReturnValue(new Promise(() => {}));
    await openWithPlan();
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await fireEvent.click(screen.getByRole("button", { name: /Stop/ }));

    const runId = hoisted.sftpSyncApply.mock.calls[0][1];
    expect(hoisted.sftpCancel).toHaveBeenCalledWith(runId);
    expect(screen.getByRole("button", { name: /Stopping/ })).toBeTruthy();
  });

  it("stays open after a stop and reports what got through", async () => {
    // One file made it, then the user stopped: the run resolves only after that
    // first file's progress has landed (starting a run clears the previous one).
    let finish: (v: unknown) => void = () => {};
    hoisted.sftpSyncApply.mockReturnValue(new Promise((r) => (finish = r)));
    const onclose = vi.fn();
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockResolvedValue([
      { path: "a.txt", sha256: "1" },
      { path: "b.txt", sha256: "2" },
    ]);
    hoisted.sftpHashTree.mockResolvedValue([]);
    render(SyncModal, {
      props: { open: true, sessionId: "sess", remotePath: "/srv/app", onclose },
    });
    await fireEvent.click(screen.getByRole("button", { name: /Choose/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByTitle("a.txt");

    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    applySyncProgress(progress("a.txt", 10, 10, true));
    finish({ uploaded: 1, downloaded: 0, deleted: 0, stopped: true });

    // The list is the report of what happened — closing would throw it away.
    await waitFor(() => expect(screen.getByText(/Stopped after the file in flight/)).toBeTruthy());
    expect(onclose).not.toHaveBeenCalled();
    // Rows the stop got to read "not done", never "queued".
    expect(screen.getByText("not done")).toBeTruthy();
    // The stale plan can only be re-compared, not re-applied.
    expect(screen.getByRole("button", { name: "Compare again" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes on a clean run", async () => {
    hoisted.sftpSyncApply.mockResolvedValue({
      uploaded: 2,
      downloaded: 0,
      deleted: 0,
      stopped: false,
    });
    const onclose = vi.fn();
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockResolvedValue([{ path: "a.txt", sha256: "1" }]);
    hoisted.sftpHashTree.mockResolvedValue([]);
    render(SyncModal, {
      props: { open: true, sessionId: "sess", remotePath: "/srv/app", onclose },
    });
    await fireEvent.click(screen.getByRole("button", { name: /Choose/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByTitle("a.txt");

    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onclose).toHaveBeenCalled());
  });
});
