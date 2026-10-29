import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class Denied extends Error {}
  class Changed extends Error {}
  return {
    Denied,
    Changed,
    sftpReadText: vi.fn(),
    readLocalText: vi.fn(),
    sftpWriteText: vi.fn(),
    writeLocalText: vi.fn(),
    sftpWriteAccess: vi.fn(async () => "writable"),
    sftpCheckSudo: vi.fn(async () => true),
    nginxConfigFiles: vi.fn(async () => [] as string[]),
    pickSavePath: vi.fn(async () => null as string | null),
    saveEditorCopy: vi.fn(async () => {}),
    annotateRecording: vi.fn(async () => {}),
    isPermissionError: (e: unknown) => e instanceof Denied,
    isFileChangedError: (e: unknown) => e instanceof Changed,
    isBackupFailedError: () => false,
  };
});
vi.mock("../api", () => api);
const toasts = vi.hoisted(() => ({ notifyError: vi.fn(), notifyInfo: vi.fn(), notifySuccess: vi.fn() }));
vi.mock("../stores/toasts.svelte", () => toasts);

import { createEditorFlow, type EditorFlow } from "./editorflow.svelte";
import { settings } from "../settings/settings.svelte";
import { findEditorByPath, getWorkspace, removeWorkspace, setEditorContent } from "../stores/workspaces.svelte";
import type { Tab } from "../stores/tabs.svelte";
import type { TextFile } from "../types";

const SID = "s1";
const file = (content: string, over: Partial<TextFile> = {}): TextFile =>
  ({ content, eol: "lf", size: content.length, mode: 0o644, mtime: 1, sha256: `sha-${content}`, encoding: "utf-8", readOnly: false, ...over }) as TextFile;

/** Let the promises the flow started settle. */
const settled = () => new Promise((r) => setTimeout(r, 0));

function harness(kind: "ssh" | "local" = "ssh") {
  let flow!: EditorFlow;
  const cleanup = $effect.root(() => {
    flow = createEditorFlow({ findTab: (id) => (id === SID ? ({ sessionId: SID, kind } as Tab) : null) });
  });
  flushSync();
  return { flow, cleanup };
}

const doc = (path: string) => findEditorByPath(SID, path);

const diffBefore = settings.editor.diffBeforeSave;
beforeEach(() => {
  vi.clearAllMocks();
  removeWorkspace(SID);
  settings.editor.diffBeforeSave = false;
  api.sftpReadText.mockImplementation(async () => file("listen 80;"));
  api.sftpWriteText.mockImplementation(async () => ({ sha256: "sha-new", size: 1, mtime: 2 }));
});
afterEach(() => {
  settings.editor.diffBeforeSave = diffBefore;
  removeWorkspace(SID);
});

describe("editor flow: opening", () => {
  it("reads first, opens the file filled, and asks ahead of editing whether a save will land", async () => {
    api.sftpWriteAccess.mockResolvedValueOnce("restricted");
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/app.conf", "app.conf", { gotoLine: 7 });
    await settled();
    expect(doc("/etc/app.conf")).toMatchObject({ content: "listen 80;", loading: false, gotoLine: 7, writeAccess: "restricted" });
    expect(api.sftpWriteAccess).toHaveBeenCalledWith(SID, "/etc/app.conf");
    cleanup();
  });

  it("a file it cannot read as the user is offered as root, not opened half-way", async () => {
    api.sftpReadText.mockRejectedValueOnce(new api.Denied("permission denied"));
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/shadow", "shadow", { gotoLine: 3 });
    expect(doc("/etc/shadow")).toBeNull();
    expect(flow.sudo).toEqual({ kind: "open", sid: SID, path: "/etc/shadow", name: "shadow", gotoLine: 3 });
    flow.sudoPassword = "pw";
    await flow.confirmSudo();
    await settled();
    expect(api.sftpReadText).toHaveBeenLastCalledWith(SID, "/etc/shadow", expect.any(Number), true, "pw");
    expect(doc("/etc/shadow")).toMatchObject({ sudo: true, sudoPassword: "pw" });
    // Opened as root: no probe of the user's own access.
    expect(api.sftpWriteAccess).not.toHaveBeenCalled();
    expect(flow.sudoPassword).toBe("");
    cleanup();
  });

  it("an open file is shown again on the line asked, not read twice", async () => {
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/app.conf", "app.conf");
    await flow.openFile(SID, "/etc/app.conf", "app.conf", { gotoLine: 12 });
    expect(api.sftpReadText).toHaveBeenCalledTimes(1);
    expect(doc("/etc/app.conf")?.gotoLine).toBe(12);
    cleanup();
  });

  it("a git diff opens over SFTP on a server and from disk on this computer", async () => {
    api.readLocalText.mockResolvedValue(file("x"));
    const ssh = harness("ssh");
    ssh.flow.openGitDiff(SID, "/srv/repo/a.ts", "HEAD-a");
    await settled();
    expect(doc("/srv/repo/a.ts")).toMatchObject({ source: "sftp", gitBase: "HEAD-a" });
    ssh.cleanup();
    removeWorkspace(SID);
    const local = harness("local");
    local.flow.openGitDiff(SID, "/Users/me/repo/b.ts", "HEAD-b");
    await settled();
    expect(doc("/Users/me/repo/b.ts")).toMatchObject({ source: "local", gitBase: "HEAD-b" });
    local.cleanup();
  });
});

describe("editor flow: saving", () => {
  async function opened(content = "a") {
    api.sftpReadText.mockResolvedValueOnce(file(content));
    const h = harness();
    await h.flow.openFile(SID, "/etc/app.conf", "app.conf");
    await settled();
    return h;
  }

  it("writes against the hash it opened, and nothing when nothing changed", async () => {
    const { flow, cleanup } = await opened();
    flow.save(SID, doc("/etc/app.conf")!);
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "b");
    flow.save(SID, doc("/etc/app.conf")!);
    await settled();
    expect(api.sftpWriteText).toHaveBeenCalledWith(SID, "/etc/app.conf", "b", "lf", "sha-a", expect.objectContaining({ sudo: false }));
    expect(doc("/etc/app.conf")).toMatchObject({ baseContent: "b", baseSha256: "sha-new" });
    cleanup();
  });

  it("a refused save keeps the edits and marks the way out next to Save — no dialog of its own", async () => {
    api.sftpWriteText.mockRejectedValueOnce(new api.Denied("permission denied"));
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    flow.save(SID, doc("/etc/app.conf")!);
    await settled();
    expect(doc("/etc/app.conf")).toMatchObject({ content: "edited", saveIssue: "permission" });
    expect(flow.sudo).toBeNull();
    cleanup();
  });

  it("'save with sudo' checks the password before keeping it, and only then writes", async () => {
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    api.sftpCheckSudo.mockResolvedValueOnce(false);
    flow.askSudo(SID, doc("/etc/app.conf")!, "save");
    flow.sudoPassword = "wrong";
    await flow.confirmSudo();
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    expect(doc("/etc/app.conf")?.sudo).toBe(false);
    expect(toasts.notifyError).toHaveBeenCalledTimes(1);
    flow.askSudo(SID, doc("/etc/app.conf")!, "save");
    flow.sudoPassword = "right";
    await flow.confirmSudo();
    await settled();
    expect(api.sftpCheckSudo).toHaveBeenLastCalledWith(SID, "right");
    expect(api.sftpWriteText).toHaveBeenCalledWith(SID, "/etc/app.conf", "edited", "lf", "sha-a", expect.objectContaining({ sudo: true, sudoPassword: "right" }));
    cleanup();
  });

  it("a check that fails on an edited file says so by Save rather than in a toast", async () => {
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    api.sftpCheckSudo.mockResolvedValueOnce(false);
    flow.askSudo(SID, doc("/etc/app.conf")!, "check");
    await flow.confirmSudo();
    expect(doc("/etc/app.conf")?.saveIssue).toBe("sudo");
    expect(toasts.notifyError).not.toHaveBeenCalled();
    cleanup();
  });

  it("a file changed on the server shows both versions; overwrite skips the hash, reopen drops the edits", async () => {
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "mine");
    api.sftpWriteText.mockRejectedValueOnce(new api.Changed("file-changed"));
    api.sftpReadText.mockResolvedValueOnce(file("theirs"));
    flow.save(SID, doc("/etc/app.conf")!);
    await settled();
    expect(flow.conflict).toMatchObject({ sid: SID, serverText: "theirs" });
    flow.overwriteConflict();
    await settled();
    expect(api.sftpWriteText).toHaveBeenLastCalledWith(SID, "/etc/app.conf", "mine", "lf", null, expect.any(Object));
    cleanup();
  });

  it("the diff before saving, when switched on, writes only once confirmed", async () => {
    settings.editor.diffBeforeSave = true;
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "b");
    flow.save(SID, doc("/etc/app.conf")!);
    expect(flow.diffSave?.doc.content).toBe("b");
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    await flow.confirmDiffSave();
    expect(api.sftpWriteText).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("editor flow: closing", () => {
  it("an unedited file closes at once; an edited one asks, and 'save' closes it only once written", async () => {
    api.sftpReadText.mockResolvedValue(file("a"));
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/clean.conf", "clean.conf");
    await flow.openFile(SID, "/etc/dirty.conf", "dirty.conf");
    await settled();
    flow.requestClose(SID, doc("/etc/clean.conf")!);
    expect(doc("/etc/clean.conf")).toBeNull();
    setEditorContent(SID, doc("/etc/dirty.conf")!.id, "b");
    flow.requestClose(SID, doc("/etc/dirty.conf")!);
    expect(flow.closeAsk?.doc.path).toBe("/etc/dirty.conf");
    api.sftpWriteText.mockRejectedValueOnce(new Error("disk full"));
    await flow.saveAndClose();
    // The write failed: the file and its edits stay.
    expect(doc("/etc/dirty.conf")?.content).toBe("b");
    flow.requestClose(SID, doc("/etc/dirty.conf")!);
    await flow.saveAndClose();
    expect(doc("/etc/dirty.conf")).toBeNull();
    expect(getWorkspace(SID).editors).toEqual([]);
    cleanup();
  });

  it("'don't save' closes without writing", async () => {
    api.sftpReadText.mockResolvedValue(file("a"));
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/x.conf", "x.conf");
    await settled();
    setEditorContent(SID, doc("/etc/x.conf")!.id, "b");
    flow.requestClose(SID, doc("/etc/x.conf")!);
    flow.discardAndClose();
    expect(doc("/etc/x.conf")).toBeNull();
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    cleanup();
  });
});
