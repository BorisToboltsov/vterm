import { beforeEach, describe, expect, it } from "vitest";
import type { EditorLang } from "../editorlang";
import type { TextFile, WriteResult } from "../types";
import {
  isDirty,
  hasUnsaved,
  nextActiveAfterClose,
  TERMINAL_VIEW,
  workspacesState,
  getWorkspace,
  addEditor,
  addScratchEditor,
  fillEditor,
  failEditor,
  setEditorContent,
  setEditorSudo,
  markSaved,
  setActiveView,
  findEditorByPath,
  closeEditor,
  removeWorkspace,
  type EditorDoc,
} from "./workspaces.svelte";

const LANG: EditorLang = { kind: "yaml", label: "YAML" };

function doc(over: Partial<EditorDoc> = {}): EditorDoc {
  return {
    id: "1",
    source: "sftp",
    path: "/a.yaml",
    name: "a.yaml",
    lang: LANG,
    content: "x",
    baseContent: "x",
    baseSha256: "sha",
    eol: "lf",
    mode: 0o644,
    readOnly: false,
    loading: false,
    loadError: null,
    sudo: false,
    sudoPassword: "",
    gotoLine: null,
    ...over,
  };
}

const file = (content: string): TextFile => ({
  content,
  eol: "lf",
  size: content.length,
  mode: 0o644,
  mtime: 1,
  sha256: "sha-" + content,
  readOnly: false,
});

describe("pure helpers", () => {
  it("isDirty compares content to base (never while loading or read-only)", () => {
    expect(isDirty(doc({ content: "x", baseContent: "x" }))).toBe(false);
    expect(isDirty(doc({ content: "y", baseContent: "x" }))).toBe(true);
    expect(isDirty(doc({ content: "y", baseContent: "x", loading: true }))).toBe(false);
  });

  it("hasUnsaved is true when any editor diverges", () => {
    const ws = { active: TERMINAL_VIEW, editors: [doc(), doc({ id: "2", content: "z" })] };
    expect(hasUnsaved(ws)).toBe(true);
    expect(hasUnsaved({ active: TERMINAL_VIEW, editors: [doc()] })).toBe(false);
  });

  it("nextActiveAfterClose keeps a non-closing active view", () => {
    const editors = [doc({ id: "a" }), doc({ id: "b" })];
    expect(nextActiveAfterClose(editors, "a", "b")).toBe("b");
    expect(nextActiveAfterClose(editors, "a", TERMINAL_VIEW)).toBe(TERMINAL_VIEW);
  });

  it("nextActiveAfterClose falls to the slot's neighbour, then terminal", () => {
    const editors = [doc({ id: "a" }), doc({ id: "b" }), doc({ id: "c" })];
    // Closing the active middle → the one that slides into its slot ("c").
    expect(nextActiveAfterClose(editors, "b", "b")).toBe("c");
    // Closing the active last → the previous ("b").
    expect(nextActiveAfterClose(editors, "c", "c")).toBe("b");
    // Closing the only editor → terminal.
    expect(nextActiveAfterClose([doc({ id: "a" })], "a", "a")).toBe(TERMINAL_VIEW);
  });
});

describe("store mutators", () => {
  beforeEach(() => {
    workspacesState.map = {};
  });

  it("addEditor creates a loading doc and activates it; getWorkspace reflects it", () => {
    const id = addEditor("s1", "/etc/app.yaml", "app.yaml", LANG);
    const ws = getWorkspace("s1");
    expect(ws.editors).toHaveLength(1);
    expect(ws.active).toBe(id);
    expect(ws.editors[0].loading).toBe(true);
    expect(ws.editors[0].source).toBe("sftp"); // default source
    expect(findEditorByPath("s1", "/etc/app.yaml")?.id).toBe(id);
  });

  it("addEditor records a local source when given", () => {
    const id = addEditor("s1", "/home/me/n.md", "n.md", LANG, "local");
    expect(getWorkspace("s1").editors.find((e) => e.id === id)?.source).toBe("local");
  });

  it("addScratchEditor opens a filled, dirty, new doc and activates it", () => {
    const id = addScratchEditor("s1", "runbook.sh", LANG, "#!/bin/sh\nls", "sftp");
    const d = getWorkspace("s1").editors.find((e) => e.id === id)!;
    expect(getWorkspace("s1").active).toBe(id);
    expect(d.loading).toBe(false);
    expect(d.content).toBe("#!/bin/sh\nls");
    expect(d.baseContent).toBe(""); // dirty — nothing saved yet
    expect(d.baseSha256).toBe(""); // marks a new file
    expect(isDirty(d)).toBe(true);
  });

  it("fillEditor loads content and clears dirty; setEditorContent makes it dirty", () => {
    const id = addEditor("s1", "/a", "a", LANG);
    fillEditor("s1", id, file("hello"));
    let d = getWorkspace("s1").editors[0];
    expect(d.loading).toBe(false);
    expect(d.content).toBe("hello");
    expect(isDirty(d)).toBe(false);

    setEditorContent("s1", id, "hello world");
    d = getWorkspace("s1").editors[0];
    expect(isDirty(d)).toBe(true);
  });

  it("markSaved adopts the new content + hash as the clean base", () => {
    const id = addEditor("s1", "/a", "a", LANG);
    fillEditor("s1", id, file("v1"));
    setEditorContent("s1", id, "v2");
    const res: WriteResult = { sha256: "sha-v2", size: 2, mtime: 9 };
    markSaved("s1", id, res);
    const d = getWorkspace("s1").editors[0];
    expect(isDirty(d)).toBe(false);
    expect(d.baseSha256).toBe("sha-v2");
  });

  it("setEditorSudo marks the doc elevated and stores the password", () => {
    const id = addEditor("s1", "/etc/hosts", "hosts", LANG);
    fillEditor("s1", id, file("127.0.0.1 localhost\n"));
    setEditorSudo("s1", id, "secret");
    const d = getWorkspace("s1").editors[0];
    expect(d.sudo).toBe(true);
    expect(d.sudoPassword).toBe("secret");
  });

  it("failEditor records the error and stops loading", () => {
    const id = addEditor("s1", "/a", "a", LANG);
    failEditor("s1", id, "too large");
    const d = getWorkspace("s1").editors[0];
    expect(d.loading).toBe(false);
    expect(d.loadError).toBe("too large");
  });

  it("closeEditor removes the tab and refocuses", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    const b = addEditor("s1", "/b", "b", LANG);
    setActiveView("s1", a);
    closeEditor("s1", b); // closing a background tab keeps the active one
    expect(getWorkspace("s1").active).toBe(a);
    closeEditor("s1", a); // closing the active last editor → terminal
    expect(getWorkspace("s1").editors).toHaveLength(0);
    expect(getWorkspace("s1").active).toBe(TERMINAL_VIEW);
  });

  it("removeWorkspace drops the whole session", () => {
    addEditor("s1", "/a", "a", LANG);
    removeWorkspace("s1");
    expect(workspacesState.map.s1).toBeUndefined();
    // Unknown session returns the shared empty default.
    expect(getWorkspace("s1").editors).toHaveLength(0);
    expect(getWorkspace(null).active).toBe(TERMINAL_VIEW);
  });
});
