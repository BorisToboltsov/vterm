// Per-connection workspace store (Svelte 5 runes): the files a session has open
// in the editor, and how the connection's area is divided between them and the
// terminal. Pure bookkeeping; reading the file content and saving it stay in
// the page / api layer.
//
// A file is shown inside its connection (v1.11, ADR 0024): the connection's
// area is one zone with the terminal and the files as views, or it is split —
// the terminal beside a file, files side by side. That layout lives here, next
// to the documents, and is only ever replaced with a result of the pure model
// (`../sessionviews.ts`, over the same tree as the centre's panes); a document
// and its view come and go in one step, so a document with no view
// (unreachable) or a view with no document (an empty zone) cannot exist.

import type { EditorLang } from "../editorlang";
import type { TextFile, WriteResult } from "../types";
import {
  closeView,
  loadViews,
  moveViewNext,
  openView,
  showView,
  splitView,
  terminalOnly,
  type ViewLayout,
} from "../sessionviews";
import {
  applyDrop,
  focusPane,
  joinPanes,
  setRatio,
  type Edge,
  type TabDrop,
} from "../splitlayout";

/** An open editor document inside a workspace. */
export interface EditorDoc {
  id: string;
  /** Where the file lives — a remote SFTP session, or the local filesystem. */
  source: "sftp" | "local";
  /** Absolute path (remote for sftp, local for local). */
  path: string;
  /** Basename, shown on the sub-tab. */
  name: string;
  lang: EditorLang;
  /** Current editor content (LF newlines). */
  content: string;
  /** Content as last opened/saved — `content !== baseContent` ⇒ dirty. */
  baseContent: string;
  /** SHA-256 the file was opened/saved with (conflict detection on save). */
  baseSha256: string;
  /** Original line-ending style, re-applied on save. */
  eol: "lf" | "crlf";
  /**
   * Encoding the file was decoded from (`utf-8`, `utf-16le-bom`, `windows-1251`…),
   * re-applied on save so a Windows UTF-16/ANSI config isn't converted to UTF-8
   * behind the owning program's back. New scratch buffers start as UTF-8.
   */
  encoding: string;
  /** Unix permission bits, if known. */
  mode: number | null;
  readOnly: boolean;
  /** True while the initial content is being fetched. */
  loading: boolean;
  /** Load error message, or null. */
  loadError: string | null;
  /** Opened/saved with sudo (root-owned file); save reuses it. */
  sudo: boolean;
  /** sudo password (in-memory only, never persisted) when `sudo` is set. */
  sudoPassword: string;
  /** 1-based line to scroll to on open (e.g. from a grep hit), or null. */
  gotoLine: number | null;
  /**
   * Git HEAD version of the file, set when opened from the git panel. Its
   * presence turns the editor into an **editable inline diff** (CodeMirror
   * `unifiedMergeView`) against this base — undefined for ordinary file opens.
   */
  gitBase?: string;
}

/** Options passed when opening an editor (sudo / line jump / git diff base). */
export interface OpenEditorOpts {
  sudo?: boolean;
  sudoPassword?: string;
  gotoLine?: number;
  gitBase?: string;
}

export interface Workspace {
  editors: EditorDoc[];
  /** The connection's zones: where the terminal and each file stand, and what each zone shows. */
  layout: ViewLayout;
}

// ── Pure helpers (tested without runes/DOM) ───────────────────────────────────

/** A document is dirty when its content diverges from the opened/saved base. */
export function isDirty(doc: EditorDoc): boolean {
  return !doc.loading && doc.content !== doc.baseContent;
}

/** Any editor in the workspace has unsaved changes. */
export function hasUnsaved(ws: Workspace): boolean {
  return ws.editors.some(isDirty);
}

// ── Runes state ───────────────────────────────────────────────────────────────

export const workspacesState = $state<{ map: Record<string, Workspace> }>({
  map: {},
});

const EMPTY: Workspace = { editors: [], layout: terminalOnly() };

/** The workspace for a session, or a shared empty default (never null). */
export function getWorkspace(sessionId: string | null): Workspace {
  return (sessionId && workspacesState.map[sessionId]) || EMPTY;
}

/** The session's workspace as stored, or null when it never opened an editor. */
export function peekWorkspace(sessionId: string): Workspace | null {
  return workspacesState.map[sessionId] ?? null;
}

/**
 * Take over the workspace of a tab moved here from another window (ADR 0017):
 * its open editors with their text and unsaved edits, standing in the zones
 * they stood in. The layout came through a packet, so it is rebuilt against the
 * editors that came with it rather than taken as it is.
 */
export function adoptWorkspace(sessionId: string, ws: Workspace): void {
  const editors = Array.isArray(ws.editors) ? ws.editors : [];
  const layout = loadViews(ws.layout, editors.map((e) => e.id));
  workspacesState.map = { ...workspacesState.map, [sessionId]: { editors, layout } };
}

function ensure(sessionId: string): Workspace {
  let ws = workspacesState.map[sessionId];
  if (!ws) {
    ws = { editors: [], layout: terminalOnly() };
    workspacesState.map = { ...workspacesState.map, [sessionId]: ws };
  }
  return ws;
}

function patch(sessionId: string, next: Partial<Workspace>): void {
  const ws = ensure(sessionId);
  workspacesState.map = {
    ...workspacesState.map,
    [sessionId]: { ...ws, ...next },
  };
}

/** Find an already-open editor for a path (so a second open just refocuses). */
export function findEditorByPath(sessionId: string, path: string): EditorDoc | null {
  return ensure(sessionId).editors.find((e) => e.path === path) ?? null;
}

/** Add a placeholder (loading) editor — shown, in the connection's file zone — and return its id. */
export function addEditor(
  sessionId: string,
  path: string,
  name: string,
  lang: EditorLang,
  source: "sftp" | "local" = "sftp",
  opts: OpenEditorOpts = {},
): string {
  const id = crypto.randomUUID();
  const doc: EditorDoc = {
    id,
    source,
    path,
    name,
    lang,
    content: "",
    baseContent: "",
    baseSha256: "",
    eol: "lf",
    encoding: "utf-8",
    mode: null,
    readOnly: false,
    loading: true,
    loadError: null,
    sudo: opts.sudo ?? false,
    sudoPassword: opts.sudoPassword ?? "",
    gotoLine: opts.gotoLine ?? null,
    gitBase: opts.gitBase,
  };
  const ws = ensure(sessionId);
  patch(sessionId, { editors: [...ws.editors, doc], layout: openView(ws.layout, id) });
  return id;
}

/**
 * Add an already-filled scratch editor (e.g. an AI-generated script) and return
 * its id. Unlike {@link addEditor}, there is no file to fetch: the content is
 * supplied directly and `baseContent` stays empty so the doc is dirty (unsaved) —
 * `baseSha256: ""` marks it as new, and the server linter still lints the buffer.
 */
export function addScratchEditor(
  sessionId: string,
  name: string,
  lang: EditorLang,
  content: string,
  source: "sftp" | "local" = "sftp",
): string {
  const id = crypto.randomUUID();
  const doc: EditorDoc = {
    id,
    source,
    path: name,
    name,
    lang,
    content,
    baseContent: "",
    baseSha256: "",
    eol: "lf",
    encoding: "utf-8",
    mode: null,
    readOnly: false,
    loading: false,
    loadError: null,
    sudo: false,
    sudoPassword: "",
    gotoLine: null,
  };
  const ws = ensure(sessionId);
  patch(sessionId, { editors: [...ws.editors, doc], layout: openView(ws.layout, id) });
  return id;
}

function updateDoc(sessionId: string, id: string, next: Partial<EditorDoc>): void {
  const ws = ensure(sessionId);
  patch(sessionId, {
    editors: ws.editors.map((e) => (e.id === id ? { ...e, ...next } : e)),
  });
}

/** Fill a loading editor with fetched file content. */
export function fillEditor(sessionId: string, id: string, file: TextFile): void {
  updateDoc(sessionId, id, {
    content: file.content,
    baseContent: file.content,
    baseSha256: file.sha256,
    eol: file.eol,
    encoding: file.encoding,
    mode: file.mode,
    readOnly: file.readOnly,
    loading: false,
    loadError: null,
  });
}

/** Mark a loading editor as failed (keeps the sub-tab so the error is visible). */
export function failEditor(sessionId: string, id: string, message: string): void {
  updateDoc(sessionId, id, { loading: false, loadError: message });
}

/** Live edit from the editor component. */
export function setEditorContent(sessionId: string, id: string, content: string): void {
  updateDoc(sessionId, id, { content });
}

/** Mark an editor as elevated (sudo) and remember its password for later saves. */
export function setEditorSudo(sessionId: string, id: string, password: string): void {
  updateDoc(sessionId, id, { sudo: true, sudoPassword: password });
}

/** Adopt fresh metadata after a successful save (clears the dirty state). */
export function markSaved(sessionId: string, id: string, result: WriteResult): void {
  const doc = ensure(sessionId).editors.find((e) => e.id === id);
  if (!doc) return;
  updateDoc(sessionId, id, {
    baseContent: doc.content,
    baseSha256: result.sha256,
    mode: doc.mode,
  });
}

/** Close a document: its view goes with it, and its zone shows the neighbour. */
export function closeEditor(sessionId: string, id: string): void {
  const ws = ensure(sessionId);
  patch(sessionId, {
    editors: ws.editors.filter((e) => e.id !== id),
    layout: closeView(ws.layout, id),
  });
}

// ── The connection's zones (v1.11) ───────────────────────────────────────────

/**
 * Replace a connection's layout with what the model makes of it. A connection
 * that never opened a file has one zone and nothing to rearrange — it gets no
 * workspace for the asking.
 */
function relayout(sessionId: string, next: (layout: ViewLayout) => ViewLayout): void {
  const ws = workspacesState.map[sessionId];
  if (!ws) return;
  const layout = next(ws.layout);
  if (layout !== ws.layout) patch(sessionId, { layout });
}

/** Show a view (the terminal or a file) in its zone; the zone takes the focus. */
export function showSessionView(sessionId: string, view: string): void {
  relayout(sessionId, (layout) => showView(layout, view));
}

/** Give a view a zone of its own at `edge` of the zone it is in. */
export function splitSessionView(sessionId: string, view: string, edge: Edge): void {
  relayout(sessionId, (layout) => splitView(layout, view, edge));
}

/** Move a view to the next zone. */
export function moveSessionViewNext(sessionId: string, view: string): void {
  relayout(sessionId, (layout) => moveViewNext(layout, view));
}

/** Drop a dragged view where the pointer left it (`viewdrag.svelte.ts`). */
export function dropSessionView(sessionId: string, view: string, drop: TabDrop): void {
  relayout(sessionId, (layout) => applyDrop(layout, view, drop));
}

/** The zone the user is working in. */
export function focusSessionZone(sessionId: string, zone: string): void {
  relayout(sessionId, (layout) => focusPane(layout, zone));
}

/** Undo the splits: one zone with every view, showing the one in focus. */
export function joinSessionZones(sessionId: string): void {
  relayout(sessionId, (layout) => joinPanes(layout));
}

/** Resize the two halves of a split between zones. */
export function setSessionZoneRatio(sessionId: string, split: string, ratio: number): void {
  relayout(sessionId, (layout) => setRatio(layout, split, ratio));
}

/** Drop a whole workspace (its connection tab closed): its files and its zones. */
export function removeWorkspace(sessionId: string): void {
  if (!workspacesState.map[sessionId]) return;
  const next = { ...workspacesState.map };
  delete next[sessionId];
  workspacesState.map = next;
}
