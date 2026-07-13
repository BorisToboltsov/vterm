// Per-connection workspace store (Svelte 5 runes): each open connection tab has a
// workspace holding the sub-views shown under the main tab bar — the terminal
// (always present) plus any open editor documents. Pure bookkeeping; reading the
// file content and saving it stay in the page / api layer.

import type { EditorLang } from "../editorlang";
import type { TextFile, WriteResult } from "../types";

/** The reserved view id for a workspace's terminal sub-tab. */
export const TERMINAL_VIEW = "terminal";

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
  /** `TERMINAL_VIEW` or an editor id. */
  active: string;
  editors: EditorDoc[];
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

/**
 * Which view to focus after `closingId` is removed: keep the current view unless
 * it's the one closing, otherwise fall to the neighbour that takes its slot, then
 * the previous one, then the terminal.
 */
export function nextActiveAfterClose(
  editors: EditorDoc[],
  closingId: string,
  currentActive: string,
): string {
  if (currentActive !== closingId) return currentActive;
  const idx = editors.findIndex((e) => e.id === closingId);
  if (idx === -1) return currentActive;
  const rest = editors.filter((e) => e.id !== closingId);
  return rest[idx]?.id ?? rest[idx - 1]?.id ?? TERMINAL_VIEW;
}

// ── Runes state ───────────────────────────────────────────────────────────────

export const workspacesState = $state<{ map: Record<string, Workspace> }>({
  map: {},
});

const EMPTY: Workspace = { active: TERMINAL_VIEW, editors: [] };

/** The workspace for a session, or a shared empty default (never null). */
export function getWorkspace(sessionId: string | null): Workspace {
  return (sessionId && workspacesState.map[sessionId]) || EMPTY;
}

function ensure(sessionId: string): Workspace {
  let ws = workspacesState.map[sessionId];
  if (!ws) {
    ws = { active: TERMINAL_VIEW, editors: [] };
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

/** Add a placeholder (loading) editor and return its id. */
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
  patch(sessionId, { editors: [...ws.editors, doc], active: id });
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
    mode: null,
    readOnly: false,
    loading: false,
    loadError: null,
    sudo: false,
    sudoPassword: "",
    gotoLine: null,
  };
  const ws = ensure(sessionId);
  patch(sessionId, { editors: [...ws.editors, doc], active: id });
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

/** Switch the active sub-view (terminal or an editor id). */
export function setActiveView(sessionId: string, view: string): void {
  patch(sessionId, { active: view });
}

/** Close an editor sub-tab, re-focusing a sensible neighbour. */
export function closeEditor(sessionId: string, id: string): void {
  const ws = ensure(sessionId);
  const active = nextActiveAfterClose(ws.editors, id, ws.active);
  patch(sessionId, {
    editors: ws.editors.filter((e) => e.id !== id),
    active,
  });
}

/** Drop a whole workspace (its connection tab closed). */
export function removeWorkspace(sessionId: string): void {
  if (!workspacesState.map[sessionId]) return;
  const next = { ...workspacesState.map };
  delete next[sessionId];
  workspacesState.map = next;
}
