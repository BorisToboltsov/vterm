// The SFTP panel and its transfers (v1.12). An upload is a job of the backend:
// the panel asks for one and waits for nothing. What it shows afterwards — the
// row, the folder re-listed once — comes from what the backend says of the job
// (`stores/transfers`), not from a loop in the panel. So the panel may be
// remounted (the dock is keyed by the active terminal tab), or its tab given to
// another window, before the job ends.
//
// And nothing replaces a file without leave (v1.11.3): the folder is asked which
// names it holds, the user is asked once for the batch, and only what was asked
// about is sent with leave to replace.
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferJob, TransferSpec } from "./api";
import type { FileEntry } from "./types";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

const sftpList = vi.fn();
const transferStart = vi.fn();
const pickUploadFiles = vi.fn();
const pickSavePath = vi.fn();
const pickSaveDir = vi.fn();
vi.mock("./api", () => ({
  sftpHome: vi.fn(async () => "/home/u"),
  sftpList: (...a: unknown[]) => sftpList(...a),
  localList: vi.fn(async () => []),
  sftpMkdir: vi.fn(),
  sftpCreateFile: vi.fn(),
  sftpDelete: vi.fn(),
  sftpRename: vi.fn(),
  sftpCopy: vi.fn(),
  sftpCancel: vi.fn(),
  sftpGrep: vi.fn(),
  transferStart: (...a: unknown[]) => transferStart(...a),
  pickUploadFiles: (...a: unknown[]) => pickUploadFiles(...a),
  pickSavePath: (...a: unknown[]) => pickSavePath(...a),
  pickSaveDir: (...a: unknown[]) => pickSaveDir(...a),
}));

import ReplaceDialog from "./ReplaceDialog.svelte";
import SftpPanel from "./SftpPanel.svelte";
import { resetDockState } from "./stores/dockstate.svelte";
import { clearReplaceQuestions } from "./stores/replaceask.svelte";
import { applyJob, clearTransfers } from "./stores/transfers.svelte";

const file = (name: string, isDir = false): FileEntry => ({
  name, path: `/home/u/${name}`, isDir, isSymlink: false, size: 1, modified: null,
  mode: null, uid: null, gid: null, user: null, group: null,
});
const settle = () => new Promise((r) => setTimeout(r, 30));

/** The spec of the n-th job the panel asked for. */
const asked = (n = 0): TransferSpec => transferStart.mock.calls[n][0] as TransferSpec;

/** What the backend would say of that job, as it stands in `state`. */
function said(spec: TransferSpec, over: Partial<TransferJob> = {}): TransferJob {
  return {
    id: spec.id,
    src: spec.src,
    dst: spec.dst,
    destDir: spec.destDir,
    name: "f",
    fileIndex: 0,
    fileCount: spec.items.length,
    transferred: 0,
    total: 10,
    state: "running",
    error: null,
    failed: 0,
    skipped: 0,
    ...over,
  };
}

const props = { sessionId: "s1", sessionReady: true, embedded: true };

beforeEach(() => {
  sftpList.mockReset().mockResolvedValue([file("a.txt"), file("b.txt")]);
  transferStart.mockReset().mockImplementation(async (spec: TransferSpec) => spec.id);
  pickUploadFiles.mockReset();
  pickSavePath.mockReset();
  pickSaveDir.mockReset();
  resetDockState();
  clearTransfers();
  clearReplaceQuestions();
});

async function connect() {
  const panel = render(SftpPanel, { props });
  render(ReplaceDialog);
  await fireEvent.click(screen.getByText("Connect"));
  await settle();
  return panel;
}

async function upload(paths: string[]) {
  pickUploadFiles.mockResolvedValue(paths);
  await fireEvent.click(screen.getByLabelText("Upload"));
  await settle();
}

describe("the SFTP panel asks the backend for a job and waits for nothing", () => {
  it("an upload of several files is one job, from the disk to this session", async () => {
    await connect();
    await upload(["/l/1.txt", "/l/2.txt", "/l/3.txt"]);
    expect(transferStart).toHaveBeenCalledTimes(1);
    expect(asked()).toMatchObject({
      src: { session: null, local: true },
      dst: { session: "s1", local: false },
      destDir: "/home/u",
      items: [
        { from: "/l/1.txt", to: "/home/u/1.txt", isDir: false, replace: false },
        { from: "/l/2.txt", to: "/home/u/2.txt", isDir: false, replace: false },
        { from: "/l/3.txt", to: "/home/u/3.txt", isDir: false, replace: false },
      ],
    });
  });

  it("shows the job's row while it runs, with which file of how many", async () => {
    await connect();
    await upload(["/l/1.txt", "/l/2.txt"]);
    applyJob(said(asked(), { name: "2.txt", fileIndex: 1, transferred: 6 }));
    await settle();
    expect(screen.getByText("2.txt")).toBeInTheDocument();
    expect(screen.getByTestId("transfer-files").textContent?.trim()).toBe("2/2");
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  it("does not list another session's job", async () => {
    await connect();
    applyJob({
      ...said({ id: "x", src: { session: null, local: true, label: "" }, dst: { session: "s2", local: false, label: "" }, items: [], destDir: "/srv" }),
      name: "theirs.bin",
    });
    await settle();
    expect(screen.queryByText("theirs.bin")).toBeNull();
  });

  it("re-lists the folder once, when the backend says the job has ended", async () => {
    let files = [file("a.txt")];
    sftpList.mockImplementation(async () => files);
    await connect();
    await upload(["/l/1", "/l/2", "/l/3", "/l/4", "/l/5"]);
    const before = sftpList.mock.calls.length;
    // Progress is not the end: nothing is listed while the job runs.
    applyJob(said(asked(), { fileIndex: 3, transferred: 6 }));
    await settle();
    expect(sftpList.mock.calls.length).toBe(before);
    files = [...files, file("1")];
    applyJob(said(asked(), { fileIndex: 5, transferred: 10, state: "done" }));
    await settle();
    expect(sftpList.mock.calls.length - before).toBe(1);
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("re-lists a panel remounted while the job was running", async () => {
    let files = [file("a.txt")];
    sftpList.mockImplementation(async () => files);
    const first = await connect();
    await upload(["/local/b.txt"]);
    const spec = asked();
    // Switch terminal tabs and back: the dock is rebuilt mid-transfer. Nothing
    // of the job lived in the panel that is gone.
    first.unmount();
    render(SftpPanel, { props });
    await settle();
    expect(screen.queryByText("b.txt")).toBeNull();
    files = [...files, file("b.txt")];
    applyJob(said(spec, { transferred: 10, state: "done" }));
    await settle();
    expect(screen.getByText("b.txt")).toBeInTheDocument();
  });

  it("a download goes where the system's dialog said, with its leave to replace", async () => {
    sftpList.mockResolvedValue([file("a.txt"), file("site", true)]);
    await connect();
    const before = sftpList.mock.calls.length;
    pickSavePath.mockResolvedValue("/Users/me/Downloads/renamed.txt");
    await fireEvent.click(screen.getAllByLabelText("Download")[0]);
    await settle();
    expect(asked()).toMatchObject({
      src: { session: "s1", local: false },
      dst: { session: null, local: true },
      destDir: "/Users/me/Downloads",
      items: [{ from: "/home/u/a.txt", to: "/Users/me/Downloads/renamed.txt", isDir: false, replace: true }],
    });
    // The dialog asked already: the folder is not listed, no second question.
    expect(sftpList.mock.calls.length).toBe(before);
    expect(screen.queryByText("Replace files?")).toBeNull();

    pickSaveDir.mockResolvedValue("/Users/me/Downloads");
    await fireEvent.click(screen.getByLabelText("Download folder"));
    await settle();
    expect(asked(1).items).toEqual([
      { from: "/home/u/site", to: "/Users/me/Downloads/site", isDir: true, replace: true },
    ]);
  });

  it("an older listing answering late does not replace a newer one", async () => {
    sftpList.mockResolvedValue([file("a.txt")]);
    await connect();
    let slow!: (v: FileEntry[]) => void;
    sftpList
      .mockImplementationOnce(() => new Promise((r) => (slow = r)))
      .mockResolvedValueOnce([file("a.txt"), file("new.txt")]);
    await fireEvent.click(screen.getByLabelText("Refresh"));
    await fireEvent.click(screen.getByLabelText("Refresh"));
    await settle();
    slow([file("a.txt")]);
    await settle();
    expect(screen.getByText("new.txt")).toBeInTheDocument();
  });
});

describe("SFTP upload onto names the folder already holds", () => {
  /** `[destination, leave to replace]` of every file of the job that was asked for. */
  const sent = () => asked().items.map((i) => [i.to, i.replace]);

  it("sends free names without asking, and without leave to replace", async () => {
    await connect();
    await upload(["/l/new.txt"]);
    expect(screen.queryByText("Replace files?")).toBeNull();
    expect(sent()).toEqual([["/home/u/new.txt", false]]);
  });

  it("asks before replacing and starts nothing until answered", async () => {
    await connect();
    await upload(["/l/a.txt"]);
    expect(screen.getByText("Replace files?")).toBeInTheDocument();
    expect(screen.getByText(/“a\.txt” already exists in “\/home\/u”/)).toBeInTheDocument();
    // One file, and it is taken: there is nothing to skip to.
    expect(screen.queryByText("Skip existing")).toBeNull();
    expect(transferStart).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByText("Replace"));
    await settle();
    expect(sent()).toEqual([["/home/u/a.txt", true]]);
  });

  it("cancel starts nothing — not even for the files whose names are free", async () => {
    await connect();
    await upload(["/l/a.txt", "/l/new.txt"]);
    await fireEvent.click(screen.getByText("Cancel"));
    await settle();
    expect(transferStart).not.toHaveBeenCalled();
    expect(screen.queryByText("Replace files?")).toBeNull();
  });

  it("skip sends only the free names", async () => {
    await connect();
    await upload(["/l/a.txt", "/l/new.txt", "/l/b.txt"]);
    expect(screen.getByTestId("replace-names").textContent).toMatch(/a\.txt\s*b\.txt/);
    await fireEvent.click(screen.getByText("Skip existing"));
    await settle();
    expect(sent()).toEqual([["/home/u/new.txt", false]]);
  });

  it("skip with every name taken starts nothing", async () => {
    await connect();
    await upload(["/l/a.txt", "/l/b.txt"]);
    // Nothing is free: the answer is replace or cancel.
    expect(screen.queryByText("Skip existing")).toBeNull();
    await fireEvent.click(screen.getByText("Cancel"));
    await settle();
    expect(transferStart).not.toHaveBeenCalled();
  });

  it("replace gives leave only to the names that were asked about", async () => {
    await connect();
    await upload(["/l/a.txt", "/l/new.txt"]);
    await fireEvent.click(screen.getByText("Replace"));
    await settle();
    expect(sent()).toEqual([
      ["/home/u/a.txt", true],
      ["/home/u/new.txt", false],
    ]);
  });

  it("two files with one name do not break the question", async () => {
    await connect();
    await upload(["/l/one/a.txt", "/l/two/a.txt", "/l/b.txt"]);
    expect(screen.getByTestId("replace-names").textContent).toMatch(/a\.txt\s*b\.txt/);
    await fireEvent.click(screen.getByText("Replace"));
    await settle();
    expect(sent()).toEqual([
      ["/home/u/a.txt", true],
      ["/home/u/a.txt", true],
      ["/home/u/b.txt", true],
    ]);
  });

  it("a folder that cannot be listed is not taken for an empty one", async () => {
    await connect();
    sftpList.mockRejectedValueOnce(new Error("permission denied"));
    await upload(["/l/new.txt"]);
    expect(screen.getByText("Copy without checking?")).toBeInTheDocument();
    expect(transferStart).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByText("Copy anyway"));
    await settle();
    expect(sent()).toEqual([["/home/u/new.txt", true]]);
  });
});
