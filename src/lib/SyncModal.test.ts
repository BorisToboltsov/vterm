import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dialog talks to the backend only through these; each test drives them.
const hoisted = vi.hoisted(() => ({
  localHashTree: vi.fn(),
  sftpHashTree: vi.fn(),
  sftpSyncApply: vi.fn(),
  sftpCancel: vi.fn(),
  pickSaveDir: vi.fn(),
  sftpList: vi.fn(),
  sftpHome: vi.fn(),
}));

const tree = (entries: { path: string; sha256: string }[], skipped = 0) => ({ entries, skipped });

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
  hoisted.localHashTree.mockResolvedValue(tree([
    { path: "a.txt", sha256: "1" },
    { path: "b.txt", sha256: "2" },
  ]));
  hoisted.sftpHashTree.mockResolvedValue(tree([]));
  render(SyncModal, {
    props: { open: true, sessionId: "sess", remotePath: "/srv/app", onclose: vi.fn() },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
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
    hoisted.localHashTree.mockResolvedValue(tree([
      { path: "a.txt", sha256: "1" },
      { path: "b.txt", sha256: "2" },
    ]));
    hoisted.sftpHashTree.mockResolvedValue(tree([]));
    render(SyncModal, {
      props: { open: true, sessionId: "sess", remotePath: "/srv/app", onclose },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
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
    hoisted.localHashTree.mockResolvedValue(tree([{ path: "a.txt", sha256: "1" }]));
    hoisted.sftpHashTree.mockResolvedValue(tree([]));
    render(SyncModal, {
      props: { open: true, sessionId: "sess", remotePath: "/srv/app", onclose },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByTitle("a.txt");

    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onclose).toHaveBeenCalled());
  });

  /** Compare with the given trees; returns once the result box is on screen. */
  async function compareWith(
    local: ReturnType<typeof tree>,
    remote: ReturnType<typeof tree>,
    setup?: () => Promise<void>,
  ) {
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockResolvedValue(local);
    hoisted.sftpHashTree.mockResolvedValue(remote);
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/srv/app" } });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await setup?.();
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  }

  it("says two empty folders are empty, not 'in sync'", async () => {
    await compareWith(tree([]), tree([]));
    expect((await screen.findByTestId("sync-empty")).textContent).toMatch(/Both folders are empty/);
    // The box explains the disabled Apply — no second, generic reason line.
    expect(screen.queryByTestId("sync-block-reason")).toBeNull();
  });

  it("explains target-only files the plan keeps", async () => {
    await compareWith(tree([]), tree([{ path: "a", sha256: "1" }, { path: "b", sha256: "2" }]));
    expect((await screen.findByTestId("sync-empty")).textContent).toMatch(
      /2 files exist only on the server/,
    );
  });

  it("warns in red when an empty source would wipe the target", async () => {
    await compareWith(tree([]), tree([{ path: "a", sha256: "1" }]), async () => {
      await fireEvent.click(screen.getByLabelText(/Delete files missing/));
    });
    expect((await screen.findByTestId("sync-wipe")).textContent).toMatch(/delete all 1 files/);
  });

  it("reports unreadable items instead of silently dropping them", async () => {
    await compareWith(tree([{ path: "a", sha256: "1" }], 3), tree([{ path: "a", sha256: "1" }]));
    expect((await screen.findByTestId("sync-skipped")).textContent).toMatch(/3 local items/);
  });

  it("shows an unreadable remote folder as an error, not an empty tree", async () => {
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockResolvedValue(tree([{ path: "a", sha256: "1" }]));
    hoisted.sftpHashTree.mockRejectedValue("sync-dir-unreadable: cannot read folder /srv/app");
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/srv/app" } });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText(/Can't read folder \/srv\/app/)).toBeTruthy();
    expect(screen.queryByTitle("a")).toBeNull();
  });

  it("explains why Compare is disabled before a local folder is chosen", () => {
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/srv/app" } });
    expect(screen.getByTestId("sync-block-reason").textContent).toMatch(/Choose a local folder/);
  });

  it("picks another remote folder in place and compares against it", async () => {
    hoisted.sftpHome.mockResolvedValue("/home/me");
    hoisted.sftpList.mockImplementation(async (_s: string, p: string) =>
      p === "/srv/app"
        ? [
            { name: "web", path: "/srv/app/web", isDir: true },
            { name: "readme", path: "/srv/app/readme", isDir: false },
          ]
        : [],
    );
    await compareWith(tree([]), tree([]), async () => {
      await fireEvent.click(screen.getByRole("button", { name: "Choose remote folder" }));
      await fireEvent.click(await screen.findByRole("button", { name: "web" }));
      await waitFor(() => expect(screen.getByText("No subfolders here")).toBeTruthy());
      // Files are not offered — only folders are something to sync into.
      expect(screen.queryByText("readme")).toBeNull();
      await fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    });
    await screen.findByTestId("sync-empty");
    expect(hoisted.sftpHashTree).toHaveBeenCalledWith("sess", "/srv/app/web");
  });

  it("does not retarget a compared plan when the panel moves while open", async () => {
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockResolvedValue(tree([{ path: "a.txt", sha256: "1" }]));
    hoisted.sftpHashTree.mockResolvedValue(tree([]));
    hoisted.sftpSyncApply.mockResolvedValue({ uploaded: 1, downloaded: 0, deleted: 0, stopped: false });
    const view = render(SyncModal, {
      props: { open: true, sessionId: "sess", remotePath: "/srv/app" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByTitle("a.txt");
    // Follow-terminal moves the panel underneath the open dialog.
    await view.rerender({ open: true, sessionId: "sess", remotePath: "/opt/elsewhere" });
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(hoisted.sftpSyncApply).toHaveBeenCalled());
    expect(hoisted.sftpSyncApply.mock.calls[0][3]).toBe("/srv/app");
  });
});
