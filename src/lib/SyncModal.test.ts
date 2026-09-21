import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
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

const tree = (entries: { path: string; sha256: string }[], skipped = 0, excluded = 0) => ({
  entries,
  skipped,
  excluded,
});

vi.mock("./api", () => hoisted);

import SyncModal from "./SyncModal.svelte";
import { applySyncProgress, clearSyncRun } from "./stores/syncrun.svelte";
import { clearToasts, toastsState } from "./stores/toasts.svelte";
import { resetSyncJobs, applyScanProgress } from "./stores/syncjob.svelte";
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
    resetSyncJobs();
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

  it("picks another remote folder in its own window, from a tree", async () => {
    hoisted.sftpHome.mockResolvedValue("/home/me");
    const listing: Record<string, { name: string; path: string; isDir: boolean }[]> = {
      "/": [{ name: "srv", path: "/srv", isDir: true }],
      "/srv": [{ name: "app", path: "/srv/app", isDir: true }],
      "/srv/app": [
        { name: "web", path: "/srv/app/web", isDir: true },
        { name: "readme", path: "/srv/app/readme", isDir: false },
      ],
    };
    hoisted.sftpList.mockImplementation(async (_s: string, p: string) => listing[p] ?? []);
    await compareWith(tree([]), tree([]), async () => {
      await fireEvent.click(screen.getByRole("button", { name: "Choose remote folder" }));
      // Opens at the dialog's folder with every ancestor expanded.
      const picker = await screen.findByTestId("sync-remote-picker");
      await waitFor(() => expect(within(picker).getByText("web")).toBeTruthy());
      expect(within(picker).getByRole("treeitem", { selected: true }).textContent).toMatch(/app/);
      // Files are not offered — only folders are something to sync into.
      expect(within(picker).queryByText("readme")).toBeNull();
      await fireEvent.click(within(picker).getByText("web"));
      await fireEvent.click(within(picker).getByRole("button", { name: "Use this folder" }));
      expect(screen.queryByTestId("sync-remote-picker")).toBeNull();
    });
    await screen.findByTestId("sync-empty");
    expect(hoisted.sftpHashTree).toHaveBeenCalledWith(
      "sess",
      "/srv/app/web",
      expect.any(Array),
      expect.any(String),
    );
  });

  it("Escape backs out of the folder picker, not the sync dialog", async () => {
    hoisted.sftpHome.mockResolvedValue("/home/me");
    hoisted.sftpList.mockResolvedValue([]);
    const onclose = vi.fn();
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/srv", onclose } });
    await fireEvent.click(screen.getByRole("button", { name: "Choose remote folder" }));
    await screen.findByTestId("sync-remote-picker");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("sync-remote-picker")).toBeNull());
    expect(onclose).not.toHaveBeenCalled();
  });

  it("asks before abandoning a compare, then really stops it", async () => {
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockReturnValue(new Promise(() => {}));
    hoisted.sftpHashTree.mockReturnValue(new Promise(() => {}));
    const onclose = vi.fn();
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/srv", onclose } });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Stop comparing?")).toBeTruthy();
    expect(onclose).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId("confirm"));
    expect(onclose).toHaveBeenCalledOnce();
    // Both sides' backend walks get their own stop flag.
    const localId = hoisted.localHashTree.mock.calls[0][2];
    const remoteId = hoisted.sftpHashTree.mock.calls[0][3];
    expect(localId).not.toBe(remoteId);
    expect(hoisted.sftpCancel).toHaveBeenCalledWith(localId);
    expect(hoisted.sftpCancel).toHaveBeenCalledWith(remoteId);
  });

  it("keeps working when the stop is declined", async () => {
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockReturnValue(new Promise(() => {}));
    hoisted.sftpHashTree.mockReturnValue(new Promise(() => {}));
    const onclose = vi.fn();
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/srv", onclose } });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await fireEvent.click(screen.getByLabelText("Close"));
    await screen.findByText("Stop comparing?");
    await userEvent.keyboard("{Escape}"); // backs out of the confirm only
    await waitFor(() => expect(screen.queryByText("Stop comparing?")).toBeNull());
    expect(onclose).not.toHaveBeenCalled();
    expect(hoisted.sftpCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Comparing…" })).toBeTruthy();
  });

  it("asks before abandoning a run and stops it by its run id", async () => {
    hoisted.sftpSyncApply.mockReturnValue(new Promise(() => {}));
    const onclose = vi.fn();
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockResolvedValue(tree([{ path: "a.txt", sha256: "1" }]));
    hoisted.sftpHashTree.mockResolvedValue(tree([]));
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/srv", onclose } });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByTitle("a.txt");
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await fireEvent.click(screen.getByLabelText("Close"));
    expect(await screen.findByText("Stop the sync?")).toBeTruthy();
    await fireEvent.click(screen.getByTestId("confirm"));
    expect(hoisted.sftpCancel).toHaveBeenCalledWith(hoisted.sftpSyncApply.mock.calls[0][1]);
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("drops the plan after a clean run, so re-opening doesn't redraw it", async () => {
    hoisted.sftpSyncApply.mockResolvedValue({ uploaded: 1, downloaded: 0, deleted: 0, stopped: false });
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockResolvedValue(tree([{ path: "a.txt", sha256: "1" }]));
    hoisted.sftpHashTree.mockResolvedValue(tree([]));
    const onclose = vi.fn();
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/srv", onclose } });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByTitle("a.txt");
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onclose).toHaveBeenCalled());
    expect(screen.queryByTitle("a.txt")).toBeNull();
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

  it("runs a compare in the background and reports when it's ready", async () => {
    let finish: (v: unknown) => void = () => {};
    hoisted.pickSaveDir.mockResolvedValue("/home/me/app");
    hoisted.localHashTree.mockReturnValue(new Promise((r) => (finish = r)));
    hoisted.sftpHashTree.mockResolvedValue(tree([]));
    const onclose = vi.fn();
    const view = render(SyncModal, {
      props: { open: true, sessionId: "sess", remotePath: "/srv", onclose },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Choose local folder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    // Counters while hashing, fed by `sync://scan`.
    const id = hoisted.localHashTree.mock.calls[0][2] as string;
    applyScanProgress({ id, files: 42 });
    await waitFor(() => expect(screen.getByTestId("sync-scan").textContent).toMatch(/local: 42/));

    await fireEvent.click(screen.getByRole("button", { name: /Run in background/ }));
    expect(onclose).toHaveBeenCalledOnce();
    expect(hoisted.sftpCancel).not.toHaveBeenCalled(); // background ≠ stop
    await view.rerender({ open: false, sessionId: "sess", remotePath: "/srv", onclose });

    finish(tree([{ path: "a.txt", sha256: "1" }]));
    await waitFor(() =>
      expect(toastsState.list.some((x) => /comparison finished: 1 changes/.test(x.message))).toBe(true),
    );
    // Re-opening shows the plan the background compare produced.
    await view.rerender({ open: true, sessionId: "sess", remotePath: "/srv", onclose });
    expect(await screen.findByTitle("a.txt")).toBeTruthy();
  });

  it("keeps the job across a remount of the panel (terminal-tab switch)", async () => {
    await compareWith(tree([{ path: "a.txt", sha256: "1" }]), tree([]));
    await screen.findByTitle("a.txt");
    cleanup();
    render(SyncModal, { props: { open: true, sessionId: "sess", remotePath: "/elsewhere" } });
    expect(screen.getByTitle("a.txt")).toBeTruthy();
    // The compared plan keeps its folder; the panel having moved doesn't retarget it.
    expect(screen.getByTitle("/srv/app")).toBeTruthy();
  });

  it("renders only a window of a huge plan", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}`, sha256: "1" }));
    await compareWith(tree(many), tree([]));
    await screen.findByTitle("f0");
    const rows = screen.getByTestId("sync-plan").querySelectorAll("[title]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
  });

  it("filters the plan by op and by top-level folder", async () => {
    await compareWith(
      tree([
        { path: "src/a", sha256: "1" },
        { path: "docs/b", sha256: "1" },
      ]),
      tree([{ path: "old/c", sha256: "1" }]),
      async () => {
        await fireEvent.click(screen.getByLabelText(/Delete files missing/));
      },
    );
    await screen.findByTitle("src/a");
    await fireEvent.click(screen.getByRole("button", { name: /^Delete 1/ }));
    expect(screen.queryByTitle("src/a")).toBeNull();
    expect(screen.getByTitle("old/c")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Folders (3)" }));
    await fireEvent.click(within(screen.getByTestId("sync-folders")).getByText("docs"));
    expect(screen.getByTitle("docs/b")).toBeTruthy();
    expect(screen.queryByTitle("src/a")).toBeNull();
  });

  it("won't start a second run while another tab's sync holds the progress feed", async () => {
    const { syncRunOwner, syncJob } = await import("./stores/syncjob.svelte");
    syncJob("other").applying = true;
    syncRunOwner.sessionId = "other";
    await compareWith(tree([{ path: "a.txt", sha256: "1" }]), tree([]));
    await screen.findByTitle("a.txt");
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("sync-block-reason").textContent).toMatch(/Another tab is syncing/);
  });
});
