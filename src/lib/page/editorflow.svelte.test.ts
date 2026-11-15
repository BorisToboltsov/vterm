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
    sudoCheck: vi.fn(async () => ({ via: "typed", rememberFailed: false })),
    sudoRoute: vi.fn(async () => ({ kind: "password", tried: "nothing" }) as unknown),
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
import { panes } from "../layout/splitlayout";
import type { Tab } from "../stores/tabs.svelte";
import type { ServerProfile, TextFile } from "../types";

const SID = "s1";
const file = (content: string, over: Partial<TextFile> = {}): TextFile =>
  ({ content, eol: "lf", size: content.length, mode: 0o644, mtime: 1, sha256: `sha-${content}`, encoding: "utf-8", readOnly: false, ...over }) as TextFile;

/** Let the promises the flow started settle. */
const settled = () => new Promise((r) => setTimeout(r, 0));

function harness(kind: "ssh" | "local" = "ssh", prod = false) {
  let flow!: EditorFlow;
  const server = { id: "srv", alias: "web", username: "deploy", prod, tags: [] } as unknown as ServerProfile;
  const cleanup = $effect.root(() => {
    flow = createEditorFlow({
      findTab: (id) => (id === SID ? ({ sessionId: SID, kind } as Tab) : null),
      serverOf: (id) => (id === SID ? server : null),
    });
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

describe("editor flow: pipelines (ADR 0068)", () => {
  it("opens one pipeline file on its schema, and turns an open one to it", async () => {
    const { flow, cleanup } = harness();
    flow.openPipelines(SID, "sftp", [{ path: "/r/.gitlab-ci.yml", isDir: false }]);
    await settled();
    expect(doc("/r/.gitlab-ci.yml")).toMatchObject({ startView: "schema", loading: false });
    flow.openPipelines(SID, "sftp", [{ path: "/r/.gitlab-ci.yml", isDir: false }]);
    await settled();
    expect(doc("/r/.gitlab-ci.yml")?.viewSeq).toBe(1);
    expect(getWorkspace(SID).editors).toHaveLength(1);
    cleanup();
  });

  it("opens a local pipeline file through the local read", async () => {
    api.readLocalText.mockImplementation(async () => file("on: push"));
    const { flow, cleanup } = harness("local");
    flow.openPipelines(SID, "local", [{ path: "/r/.github/workflows/ci.yml", isDir: false }]);
    await settled();
    expect(api.readLocalText).toHaveBeenCalled();
    expect(doc("/r/.github/workflows/ci.yml")?.startView).toBe("schema");
    cleanup();
  });

  it("opens a folder or several files on the map of their pipelines", () => {
    const { flow, cleanup } = harness();
    flow.openPipelines(SID, "sftp", [{ path: "/r/.github/workflows", isDir: true }]);
    flow.openPipelines(SID, "sftp", [
      { path: "/r/.github/workflows/a.yml", isDir: false },
      { path: "/r/.github/workflows/b.yml", isDir: false },
    ]);
    flow.openPipelines(SID, "sftp", []);
    const views = getWorkspace(SID).editors.filter((e) => e.pipelines);
    expect(views.map((v) => v.name)).toEqual(["Pipelines · workflows", "Pipelines · workflows"]);
    expect(views[1].pipelines?.targets).toHaveLength(2);
    expect(api.sftpReadText).not.toHaveBeenCalled();
    cleanup();
  });
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
    await flow.openFile(SID, "/etc/shadow", "shadow", { gotoLine: 3, gotoColumn: 9 });
    await settled();
    expect(doc("/etc/shadow")).toBeNull();
    expect(flow.sudo).toMatchObject({ kind: "open", sid: SID, path: "/etc/shadow", gotoLine: 3, gotoColumn: 9, mode: "type" });
    flow.sudoPassword = "pw";
    await flow.confirmSudo();
    await settled();
    // The typed password goes to the check once — remembered by default — and
    // the read as root takes the session's, never a password of its own.
    expect(api.sudoCheck).toHaveBeenCalledWith(SID, "pw", true);
    expect(api.sftpReadText).toHaveBeenLastCalledWith(SID, "/etc/shadow", expect.any(Number), true);
    expect(doc("/etc/shadow")).toMatchObject({ sudo: true, gotoLine: 3, gotoColumn: 9 });
    expect(Object.keys(doc("/etc/shadow")!)).not.toContain("sudoPassword");
    // Opened as root: no probe of the user's own access.
    expect(api.sftpWriteAccess).not.toHaveBeenCalled();
    expect(flow.sudoPassword).toBe("");
    cleanup();
  });

  it("with sudo that needs no typing, a file it cannot read opens as root at once", async () => {
    api.sftpReadText.mockRejectedValueOnce(new api.Denied("permission denied"));
    api.sudoRoute.mockResolvedValueOnce({ kind: "saved", from: "saved" });
    api.sudoCheck.mockResolvedValueOnce({ via: "saved", rememberFailed: false });
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/shadow", "shadow");
    await settled();
    expect(flow.sudo).toBeNull();
    expect(api.sudoCheck).toHaveBeenCalledWith(SID, null, false);
    expect(doc("/etc/shadow")).toMatchObject({ sudo: true });
    cleanup();
  });

  it("on prod the same takes one explicit yes, naming whose password goes", async () => {
    api.sftpReadText.mockRejectedValueOnce(new api.Denied("permission denied"));
    api.sudoRoute.mockResolvedValueOnce({ kind: "saved", from: "login" });
    const { flow, cleanup } = harness("ssh", true);
    await flow.openFile(SID, "/etc/shadow", "shadow");
    await settled();
    expect(flow.sudo).toMatchObject({ kind: "open", mode: "confirm", source: "login" });
    expect(flow.sudoWho(SID)).toEqual({ who: "deploy@web", prod: true });
    expect(api.sudoCheck).not.toHaveBeenCalled();
    await flow.confirmSudo();
    await settled();
    expect(api.sudoCheck).toHaveBeenCalledWith(SID, null, false);
    expect(doc("/etc/shadow")).toMatchObject({ sudo: true });
    cleanup();
  });

  it("a file the user cannot write learns at once what saving it will take", async () => {
    api.sftpWriteAccess.mockResolvedValueOnce("restricted");
    api.sudoRoute.mockResolvedValueOnce({ kind: "refused", why: "not-allowed", said: "Sorry, user deploy may not run sudo on web." });
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/app.conf", "app.conf");
    await settled();
    expect(doc("/etc/app.conf")?.sudoRoute).toEqual({ kind: "refused", why: "not-allowed", said: "Sorry, user deploy may not run sudo on web." });
    cleanup();
  });

  it("an open file is shown again on the line asked, not read twice", async () => {
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/app.conf", "app.conf");
    await flow.openFile(SID, "/etc/app.conf", "app.conf", { gotoLine: 12, gotoColumn: 4 });
    expect(api.sftpReadText).toHaveBeenCalledTimes(1);
    expect(doc("/etc/app.conf")).toMatchObject({ gotoLine: 12, gotoColumn: 4 });
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

  it("'save with sudo': a wrong password stays in the prompt, said there; a right one writes", async () => {
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    api.sudoCheck.mockRejectedValueOnce("sudo-rejected: sudo did not accept the password");
    flow.askSudo(SID, doc("/etc/app.conf")!, "save");
    await settled();
    flow.sudoPassword = "wrong";
    await flow.confirmSudo();
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    expect(doc("/etc/app.conf")?.sudo).toBe(false);
    expect(flow.sudo).toMatchObject({ kind: "save", mode: "type", note: "sudo.wrongPassword" });
    expect(flow.sudoPassword).toBe("");
    expect(toasts.notifyError).not.toHaveBeenCalled();
    flow.sudoRemember = false;
    flow.sudoPassword = "right";
    await flow.confirmSudo();
    await settled();
    expect(api.sudoCheck).toHaveBeenLastCalledWith(SID, "right", false);
    expect(api.sftpWriteText).toHaveBeenCalledWith(SID, "/etc/app.conf", "edited", "lf", "sha-a", expect.objectContaining({ sudo: true }));
    expect(flow.sudo).toBeNull();
    cleanup();
  });

  it("no sudo rights, asked ahead of editing: said plainly — not «write access needed» again", async () => {
    const { flow, cleanup } = await opened();
    api.sudoCheck.mockRejectedValueOnce("sudo-refused: not-allowed: Sorry, user deploy may not run sudo on web.");
    api.sudoRoute.mockResolvedValueOnce({ kind: "ready", via: "none" });
    flow.askSudo(SID, doc("/etc/app.conf")!, "check");
    await settled();
    expect(doc("/etc/app.conf")?.sudoRoute).toMatchObject({ kind: "refused", why: "not-allowed" });
    expect(toasts.notifyError).toHaveBeenCalledWith(expect.stringContaining("No sudo rights"), expect.objectContaining({ source: "editor" }));
    expect(toasts.notifyError).toHaveBeenCalledWith(expect.stringContaining("may not run sudo"), expect.anything());
    expect(flow.sudo).toBeNull();
    cleanup();
  });

  it("the same on an edited file is said by Save, with the edits kept", async () => {
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    api.sudoRoute.mockResolvedValueOnce({ kind: "ready", via: "none" });
    api.sudoCheck.mockRejectedValueOnce("sudo-refused: not-allowed: Sorry, user deploy may not run sudo on web.");
    flow.askSudo(SID, doc("/etc/app.conf")!, "check");
    await settled();
    expect(doc("/etc/app.conf")).toMatchObject({ saveIssue: "sudo", content: "edited" });
    expect(toasts.notifyError).not.toHaveBeenCalled();
    cleanup();
  });

  it("a file sudo will not write is not offered a Save that cannot land", async () => {
    api.sftpWriteAccess.mockResolvedValueOnce("restricted");
    api.sudoRoute.mockResolvedValueOnce({ kind: "refused", why: "no-sudo", said: "" });
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    flow.save(SID, doc("/etc/app.conf")!);
    await settled();
    expect(api.sftpWriteText).not.toHaveBeenCalled();
    expect(doc("/etc/app.conf")?.saveIssue).toBe("sudo");
    cleanup();
  });

  it("Save of a file the user cannot write goes through sudo when sudo needs no typing", async () => {
    api.sftpWriteAccess.mockResolvedValueOnce("restricted");
    api.sudoRoute.mockResolvedValueOnce({ kind: "saved", from: "saved" });
    api.sudoCheck.mockResolvedValueOnce({ via: "saved", rememberFailed: false });
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    flow.save(SID, doc("/etc/app.conf")!);
    await settled();
    expect(api.sudoCheck).toHaveBeenCalledWith(SID, null, false);
    expect(api.sftpWriteText).toHaveBeenCalledWith(SID, "/etc/app.conf", "edited", "lf", "sha-a", expect.objectContaining({ sudo: true }));
    expect(doc("/etc/app.conf")).toMatchObject({ sudo: true, sudoRoute: { kind: "ready", via: "saved" } });
    cleanup();
  });

  it("a save as root whose password was changed meanwhile asks again, saying why", async () => {
    api.sftpReadText.mockResolvedValueOnce(file("a"));
    const { flow, cleanup } = harness();
    await flow.openFile(SID, "/etc/app.conf", "app.conf", { sudo: true });
    await settled();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    api.sftpWriteText.mockRejectedValueOnce("sudo-password: saved");
    flow.save(SID, doc("/etc/app.conf")!);
    await settled();
    expect(flow.sudo).toMatchObject({ kind: "save", mode: "type", note: "sudo.triedSaved" });
    expect(doc("/etc/app.conf")).toMatchObject({ content: "edited", saveIssue: "none" });
    cleanup();
  });

  it("a password sudo took but the keychain did not keep is said, and the save goes on", async () => {
    const { flow, cleanup } = await opened();
    setEditorContent(SID, doc("/etc/app.conf")!.id, "edited");
    api.sudoCheck.mockResolvedValueOnce({ via: "typed", rememberFailed: true });
    flow.askSudo(SID, doc("/etc/app.conf")!, "save");
    await settled();
    flow.sudoPassword = "pw";
    await flow.confirmSudo();
    await settled();
    expect(toasts.notifyInfo).toHaveBeenCalledWith(expect.stringContaining("keychain"), expect.anything());
    expect(api.sftpWriteText).toHaveBeenCalled();
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

describe("the first file beside the terminal (v1.35)", () => {
  const zones = () => panes(getWorkspace(SID).layout).length;
  function withRoom(room: boolean) {
    let flow!: EditorFlow;
    const cleanup = $effect.root(() => {
      flow = createEditorFlow({
        findTab: (id) => (id === SID ? ({ sessionId: SID, kind: "ssh" } as Tab) : null),
        roomBeside: () => room,
      });
    });
    flushSync();
    return { flow, cleanup };
  }
  const was = settings.editor.openBeside;
  afterEach(() => {
    settings.editor.openBeside = was;
  });

  it("opens in a zone of its own when the setting is on and the terminal has room", async () => {
    settings.editor.openBeside = true;
    const { flow, cleanup } = withRoom(true);
    await flow.openFile(SID, "/etc/app.conf", "app.conf");
    await settled();
    expect(zones()).toBe(2);
    cleanup();
  });

  it("covers the terminal without room, or with the setting off", async () => {
    settings.editor.openBeside = true;
    const tight = withRoom(false);
    await tight.flow.openFile(SID, "/etc/app.conf", "app.conf");
    await settled();
    expect(zones()).toBe(1);
    tight.cleanup();
    removeWorkspace(SID);
    settings.editor.openBeside = false;
    const off = withRoom(true);
    await off.flow.openFile(SID, "/etc/app.conf", "app.conf");
    await settled();
    expect(zones()).toBe(1);
    off.cleanup();
  });
});
