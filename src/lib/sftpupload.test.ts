// SFTP panel re-lists after an upload (v1.0.42) — once per batch, and also when the
// panel was remounted while the upload ran (the dock is keyed by the active terminal
// tab, so switching tabs and back rebuilds it). The re-list goes through the dock
// store's directory revision, not the component that started the upload.
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "./types";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

const sftpList = vi.fn();
const sftpUpload = vi.fn();
const pickUploadFiles = vi.fn();
vi.mock("./api", () => ({
  sftpHome: vi.fn(async () => "/home/u"),
  sftpList: (...a: unknown[]) => sftpList(...a),
  sftpMkdir: vi.fn(),
  sftpCreateFile: vi.fn(),
  sftpDelete: vi.fn(),
  sftpRename: vi.fn(),
  sftpCopy: vi.fn(),
  sftpUpload: (...a: unknown[]) => sftpUpload(...a),
  sftpDownload: vi.fn(),
  sftpCancelTransfer: vi.fn(),
  grepRemote: vi.fn(),
  pickUploadFiles: (...a: unknown[]) => pickUploadFiles(...a),
}));

import SftpPanel from "./SftpPanel.svelte";
import { resetDockState } from "./stores/dockstate.svelte";
import { toastsState } from "./stores/toasts.svelte";

const toastTexts = () => toastsState.list.map((x) => x.message);

const file = (name: string): FileEntry => ({
  name, path: `/home/u/${name}`, isDir: false, isSymlink: false, size: 1, modified: null,
  mode: null, uid: null, gid: null, user: null, group: null,
});
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("SFTP re-list after upload", () => {
  beforeEach(() => {
    sftpList.mockReset();
    sftpUpload.mockReset().mockResolvedValue(undefined);
    pickUploadFiles.mockReset();
    resetDockState();
  });

  const props = { sessionId: "s1", sessionReady: true, embedded: true };
  async function connect() {
    const r = render(SftpPanel, { props });
    await fireEvent.click(screen.getByText("Connect"));
    await settle();
    return r;
  }

  it("shows the uploaded file without pressing refresh", async () => {
    let files = [file("a.txt")];
    sftpList.mockImplementation(async () => files);
    sftpUpload.mockImplementation(async () => {
      files = [...files, file("b.txt")];
    });
    pickUploadFiles.mockResolvedValue(["/local/b.txt"]);
    await connect();
    await fireEvent.click(screen.getByLabelText("Upload"));
    await settle();
    expect(screen.getByText("b.txt")).toBeInTheDocument();
  });

  it("re-lists once after a batch of many files, not after each", async () => {
    sftpList.mockResolvedValue([file("a.txt")]);
    pickUploadFiles.mockResolvedValue(["/l/1", "/l/2", "/l/3", "/l/4", "/l/5"]);
    await connect();
    const before = sftpList.mock.calls.length;
    await fireEvent.click(screen.getByLabelText("Upload"));
    await settle();
    expect(sftpUpload).toHaveBeenCalledTimes(5);
    // One listing before the batch (which names are taken) and one after it.
    expect(sftpList.mock.calls.length - before).toBe(2);
  });

  it("re-lists a panel remounted while the upload was running", async () => {
    let files = [file("a.txt")];
    sftpList.mockImplementation(async () => files);
    let finish!: () => void;
    sftpUpload.mockImplementation(
      () => new Promise<void>((r) => (finish = () => ((files = [...files, file("b.txt")]), r()))),
    );
    pickUploadFiles.mockResolvedValue(["/local/b.txt"]);
    const first = await connect();
    await fireEvent.click(screen.getByLabelText("Upload"));
    await settle();
    // Switch terminal tabs and back: the dock is rebuilt mid-upload.
    first.unmount();
    render(SftpPanel, { props });
    await settle();
    expect(screen.queryByText("b.txt")).toBeNull();
    finish();
    await settle();
    expect(screen.getByText("b.txt")).toBeInTheDocument();
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

// A file dropped on the window replaced its namesake on the server without a
// question (v1.11.3). The folder is asked which names it holds, the user is asked
// once for the batch, and only what was asked about is sent with leave to replace.
describe("SFTP upload onto names the folder already holds", () => {
  beforeEach(() => {
    sftpList.mockReset().mockResolvedValue([file("a.txt"), file("b.txt")]);
    sftpUpload.mockReset().mockResolvedValue(undefined);
    pickUploadFiles.mockReset();
    resetDockState();
  });

  const props = { sessionId: "s1", sessionReady: true, embedded: true };
  async function upload(paths: string[]) {
    render(SftpPanel, { props });
    await fireEvent.click(screen.getByText("Connect"));
    await settle();
    pickUploadFiles.mockResolvedValue(paths);
    await fireEvent.click(screen.getByLabelText("Upload"));
    await settle();
  }
  /** `[remote path, replace]` of every upload that was sent. */
  const sent = () => sftpUpload.mock.calls.map((c) => [c[3], c[4]]);

  it("sends free names without asking, and without leave to replace", async () => {
    await upload(["/l/new.txt"]);
    expect(screen.queryByText("Replace files?")).toBeNull();
    expect(sent()).toEqual([["/home/u/new.txt", false]]);
  });

  it("asks before replacing and sends nothing until answered", async () => {
    await upload(["/l/a.txt"]);
    expect(screen.getByText("Replace files?")).toBeInTheDocument();
    expect(screen.getByText(/“a\.txt” already exists in “\/home\/u”/)).toBeInTheDocument();
    // One file, and it is taken: there is nothing to skip to.
    expect(screen.queryByText("Skip existing")).toBeNull();
    expect(sftpUpload).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByText("Replace"));
    await settle();
    expect(sent()).toEqual([["/home/u/a.txt", true]]);
  });

  it("cancel uploads nothing — not even the files whose names are free", async () => {
    await upload(["/l/a.txt", "/l/new.txt"]);
    await fireEvent.click(screen.getByText("Cancel"));
    await settle();
    expect(sftpUpload).not.toHaveBeenCalled();
    expect(screen.queryByText("Replace files?")).toBeNull();
  });

  it("skip sends only the free names", async () => {
    await upload(["/l/a.txt", "/l/new.txt", "/l/b.txt"]);
    expect(screen.getByTestId("replace-names").textContent).toMatch(/a\.txt\s*b\.txt/);
    await fireEvent.click(screen.getByText("Skip existing"));
    await settle();
    expect(sent()).toEqual([["/home/u/new.txt", false]]);
  });

  it("replace gives leave only to the names that were asked about", async () => {
    await upload(["/l/a.txt", "/l/new.txt"]);
    await fireEvent.click(screen.getByText("Replace"));
    await settle();
    expect(sent()).toEqual([
      ["/home/u/a.txt", true],
      ["/home/u/new.txt", false],
    ]);
  });

  it("two dropped files with one name do not break the question", async () => {
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
    render(SftpPanel, { props });
    await fireEvent.click(screen.getByText("Connect"));
    await settle();
    sftpList.mockRejectedValueOnce(new Error("permission denied"));
    pickUploadFiles.mockResolvedValue(["/l/new.txt"]);
    await fireEvent.click(screen.getByLabelText("Upload"));
    await settle();
    expect(screen.getByText("Upload without checking?")).toBeInTheDocument();
    expect(sftpUpload).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByText("Upload anyway"));
    await settle();
    expect(sent()).toEqual([["/home/u/new.txt", true]]);
  });

  it("a name taken since the folder was asked is refused, and said so", async () => {
    sftpUpload.mockRejectedValue("dest-exists: a file or folder with that name already exists");
    await upload(["/l/new.txt"]);
    expect(sent()).toEqual([["/home/u/new.txt", false]]);
    expect(toastTexts()).toContain("“new.txt” already exists in “/home/u”");
  });
});
