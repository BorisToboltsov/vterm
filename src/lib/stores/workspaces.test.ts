import { beforeEach, describe, expect, it } from "vitest";
import type { EditorLang } from "../editorlang";
import type { TextFile, WriteResult } from "../types";
import {
  isDirty,
  hasUnsaved,
  adoptWorkspace,
  workspacesState,
  getWorkspace,
  peekWorkspace,
  addEditor,
  addScratchEditor,
  fillEditor,
  failEditor,
  setEditorContent,
  setEditorSudo,
  markSaved,
  findEditorByPath,
  closeEditor,
  removeWorkspace,
  dropSessionView,
  focusSessionZone,
  joinSessionZones,
  moveSessionViewNext,
  setSessionZoneRatio,
  showSessionView,
  splitSessionView,
  type EditorDoc,
} from "./workspaces.svelte";
import { layoutProblems, paneOf, panes } from "../splitlayout";
import {
  TERMINAL_VIEW,
  focusedFile,
  terminalFocused,
  terminalOnly,
  terminalShown,
} from "../sessionviews";

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
    encoding: "utf-8",
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
  encoding: "utf-8",
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
    const layout = terminalOnly();
    const ws = { editors: [doc(), doc({ id: "2", content: "z" })], layout };
    expect(hasUnsaved(ws)).toBe(true);
    expect(hasUnsaved({ editors: [doc()], layout })).toBe(false);
  });
});

describe("store mutators", () => {
  beforeEach(() => {
    workspacesState.map = {};
  });

  it("addEditor creates a loading doc; getWorkspace reflects it", () => {
    const id = addEditor("s1", "/etc/app.yaml", "app.yaml", LANG);
    const ws = getWorkspace("s1");
    expect(ws.editors).toHaveLength(1);
    expect(ws.editors[0].loading).toBe(true);
    expect(ws.editors[0].source).toBe("sftp"); // default source
    expect(findEditorByPath("s1", "/etc/app.yaml")?.id).toBe(id);
  });

  it("addEditor records a local source when given", () => {
    const id = addEditor("s1", "/home/me/n.md", "n.md", LANG, "local");
    expect(getWorkspace("s1").editors.find((e) => e.id === id)?.source).toBe("local");
  });

  it("addScratchEditor opens a filled, dirty, new doc", () => {
    const id = addScratchEditor("s1", "runbook.sh", LANG, "#!/bin/sh\nls", "sftp");
    const d = getWorkspace("s1").editors.find((e) => e.id === id)!;
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

  it("closeEditor removes the document and only it", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    const b = addEditor("s1", "/b", "b", LANG);
    closeEditor("s1", b);
    expect(getWorkspace("s1").editors.map((e) => e.id)).toEqual([a]);
    closeEditor("s1", a);
    expect(getWorkspace("s1").editors).toHaveLength(0);
  });

  it("removeWorkspace drops the whole session", () => {
    addEditor("s1", "/a", "a", LANG);
    removeWorkspace("s1");
    expect(workspacesState.map.s1).toBeUndefined();
    // Unknown session returns the shared empty default.
    expect(getWorkspace("s1").editors).toHaveLength(0);
    expect(getWorkspace(null).editors).toEqual([]);
  });
});

// ── A file is a view inside its connection (v1.11, ADR 0024) ─────────────────

describe("a connection's files and zones", () => {
  const T = TERMINAL_VIEW;
  /** Zones in reading order, `*` on the view each shows. */
  const shape = (sid: string): string[][] =>
    panes(getWorkspace(sid).layout).map((zone) =>
      zone.tabs.map((view) => (zone.active === view ? `${view}*` : view)),
    );
  const views = (sid: string) => getWorkspace(sid).layout;
  const ids = (sid: string) => [T, ...getWorkspace(sid).editors.map((e) => e.id)];

  beforeEach(() => {
    workspacesState.map = {};
  });

  it("a connection that never opened a file is one zone showing its terminal", () => {
    expect(shape("s1")).toEqual([[`${T}*`]]);
    expect(terminalShown(views("s1"))).toBe(true);
    // Asking does not make a workspace of it.
    expect(peekWorkspace("s1")).toBeNull();
  });

  it("an opened file is a view next to the terminal, shown in its place", () => {
    const id = addEditor("s1", "/etc/app.yaml", "app.yaml", LANG);
    expect(shape("s1")).toEqual([[T, `${id}*`]]);
    expect(focusedFile(views("s1"))).toBe(id);
    expect(terminalShown(views("s1"))).toBe(false);
    expect(layoutProblems(views("s1"), ids("s1"))).toEqual([]);
  });

  it("a generated script opens the same way", () => {
    const id = addScratchEditor("s1", "runbook.sh", LANG, "ls", "local");
    expect(shape("s1")).toEqual([[T, `${id}*`]]);
  });

  it("the document and its view come and go in one step", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    const b = addEditor("s1", "/b", "b", LANG);
    expect(layoutProblems(views("s1"), ids("s1"))).toEqual([]);
    closeEditor("s1", b);
    expect(shape("s1")).toEqual([[T, `${a}*`]]);
    expect(layoutProblems(views("s1"), ids("s1"))).toEqual([]);
    closeEditor("s1", a);
    expect(shape("s1")).toEqual([[`${T}*`]]);
    expect(getWorkspace("s1").editors).toEqual([]);
  });

  it("the file goes beside the terminal, and a second file beside the first", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    splitSessionView("s1", a, "right");
    expect(shape("s1")).toEqual([[`${T}*`], [`${a}*`]]);
    expect(terminalShown(views("s1"))).toBe(true);
    // Opened while the terminal's zone is in focus, the next file joins the files.
    showSessionView("s1", T);
    expect(terminalFocused(views("s1"))).toBe(true);
    const b = addEditor("s1", "/b", "b", LANG);
    expect(shape("s1")).toEqual([[`${T}*`], [a, `${b}*`]]);
    splitSessionView("s1", b, "right");
    expect(shape("s1")).toEqual([[`${T}*`], [`${a}*`], [`${b}*`]]);
    expect(layoutProblems(views("s1"), ids("s1"))).toEqual([]);
  });

  it("a view moves to the next zone; the zones join back into one", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    const b = addEditor("s1", "/b", "b", LANG);
    splitSessionView("s1", b, "bottom");
    moveSessionViewNext("s1", a);
    expect(shape("s1")).toEqual([[`${T}*`], [b, `${a}*`]]);
    joinSessionZones("s1");
    expect(shape("s1")).toEqual([[T, b, `${a}*`]]);
  });

  it("a dragged view lands where it was dropped: a strip, a zone, or a new zone at an edge", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    const b = addEditor("s1", "/b", "b", LANG);
    const only = paneOf(views("s1"), T)!.id;
    // Onto the body's lower edge: a zone of its own below.
    dropSessionView("s1", b, { kind: "pane", pane: only, zone: "bottom" });
    expect(shape("s1")).toEqual([[T, `${a}*`], [`${b}*`]]);
    // Into the other zone's strip, at its start.
    const lower = paneOf(views("s1"), b)!.id;
    dropSessionView("s1", a, { kind: "strip", pane: lower, index: 0 });
    expect(shape("s1")).toEqual([[`${T}*`], [`${a}*`, b]]);
    // Onto a zone's middle: it joins that zone, and the zone it emptied goes.
    dropSessionView("s1", T, { kind: "pane", pane: lower, zone: "center" });
    expect(shape("s1")).toEqual([[a, b, `${T}*`]]);
    expect(layoutProblems(views("s1"), ids("s1"))).toEqual([]);
    // A drop that names a zone that is gone changes nothing.
    const before = peekWorkspace("s1");
    dropSessionView("s1", a, { kind: "pane", pane: "nope", zone: "right" });
    expect(peekWorkspace("s1")).toBe(before);
  });

  it("a view that closed while it was in the air is not put back by its drop", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    const b = addEditor("s1", "/b", "b", LANG);
    const only = paneOf(views("s1"), T)!.id;
    // The file is closed between the last move and the release.
    closeEditor("s1", b);
    const before = peekWorkspace("s1");
    dropSessionView("s1", b, { kind: "pane", pane: only, zone: "right" });
    dropSessionView("s1", b, { kind: "pane", pane: only, zone: "center" });
    dropSessionView("s1", b, { kind: "strip", pane: only, index: 0 });
    expect(peekWorkspace("s1")).toBe(before);
    expect(shape("s1")).toEqual([[T, `${a}*`]]);
    expect(layoutProblems(views("s1"), ids("s1"))).toEqual([]);
  });

  it("the zone the user works in takes the focus, and a split can be resized", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    splitSessionView("s1", a, "right");
    const termZone = paneOf(views("s1"), T)!.id;
    focusSessionZone("s1", termZone);
    expect(terminalFocused(views("s1"))).toBe(true);
    const root = views("s1").root;
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      setSessionZoneRatio("s1", root.id, 0.3);
      const next = views("s1").root;
      expect(next.kind === "split" && next.ratio).toBe(0.3);
    }
  });

  it("closing the last file of a zone gives its room back", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    splitSessionView("s1", a, "right");
    closeEditor("s1", a);
    expect(shape("s1")).toEqual([[`${T}*`]]);
    expect(terminalFocused(views("s1"))).toBe(true);
  });

  it("a connection with no files has nothing to rearrange — and gets no workspace for the asking", () => {
    showSessionView("nobody", T);
    splitSessionView("nobody", T, "right");
    moveSessionViewNext("nobody", T);
    focusSessionZone("nobody", "p0");
    joinSessionZones("nobody");
    setSessionZoneRatio("nobody", "s1", 0.3);
    dropSessionView("nobody", T, { kind: "pane", pane: "p0", zone: "right" });
    expect(peekWorkspace("nobody")).toBeNull();
  });

  it("what changes nothing does not replace the workspace", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    const before = peekWorkspace("s1");
    showSessionView("s1", a);
    splitSessionView("s1", "gone", "right");
    joinSessionZones("s1");
    expect(peekWorkspace("s1")).toBe(before);
  });

  it("files that arrive with their connection stand where they stood", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    const b = addEditor("s1", "/b", "b", LANG);
    splitSessionView("s1", b, "right");
    const packed = JSON.parse(JSON.stringify(peekWorkspace("s1")));
    removeWorkspace("s1");
    adoptWorkspace("s1", packed);
    expect(shape("s1")).toEqual([[T, `${a}*`], [`${b}*`]]);
    expect(layoutProblems(views("s1"), ids("s1"))).toEqual([]);
  });

  it("a layout that does not fit the files it came with is rebuilt, not trusted", () => {
    const junk = { root: { kind: "pane", id: "x", tabs: ["ghost", "d1"], active: "ghost" }, focus: "x", seq: 9 };
    adoptWorkspace("s1", {
      editors: [doc({ id: "d1" }), doc({ id: "d2", path: "/b" })],
      layout: junk as never,
    });
    expect(layoutProblems(views("s1"), [T, "d1", "d2"])).toEqual([]);
    expect(paneOf(views("s1"), "ghost")).toBeNull();
    // No layout at all: the terminal, with the files behind it.
    adoptWorkspace("s2", { editors: [doc({ id: "d3" })], layout: undefined as never });
    expect(shape("s2")).toEqual([[`${T}*`, "d3"]]);
    adoptWorkspace("s3", { editors: undefined as never, layout: undefined as never });
    expect(shape("s3")).toEqual([[`${T}*`]]);
  });

  it("the connection going takes its files and its zones", () => {
    const a = addEditor("s1", "/a", "a", LANG);
    splitSessionView("s1", a, "right");
    removeWorkspace("s1");
    expect(peekWorkspace("s1")).toBeNull();
    expect(shape("s1")).toEqual([[`${T}*`]]);
  });
});
