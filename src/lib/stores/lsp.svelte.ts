// The language servers of the open editors (ADR 0079). One server per tab,
// project folder and server kind, shared by every editor of that folder and
// stopped when the last of them lets go or the tab closes (`forgetLsp` in
// `closeTabFully`; the backend stops them with the session too). A server that
// is not installed is remembered as such for the tab, so the status bar can
// offer to install it instead of trying again on every file.

import { lspSend, lspStart, lspStop, onLspClosed, onLspMessage } from "../api/lsp";
import { diag, swallow } from "../api/diag";
import { connectClient, type LspHandle } from "../editor/lspclient";

export type LspStatus = "starting" | "running" | "missing" | "failed" | "stopped";

export interface LspRequest {
  sessionId: string;
  /** The file is on this computer: the server runs here, not on the server. */
  local: boolean;
  server: string;
  root: string;
}

interface Live {
  req: LspRequest;
  id: string | null;
  handle: Promise<LspHandle | null>;
  refs: number;
  unlisten: (() => void)[];
}

const live = new Map<string, Live>();
const state = $state<{ status: Record<string, LspStatus>; said: Record<string, string> }>({ status: {}, said: {} });

/** The key of a server: its tab, where it runs, which server, which folder. */
export function lspEntryKey(r: LspRequest): string {
  return `${r.sessionId}|${r.local ? "local" : "remote"}|${r.server}|${r.root}`;
}

/** How a server is doing, for the status bar; null — never asked for. */
export function lspStatus(key: string): LspStatus | null {
  return state.status[key] ?? null;
}

/** The last thing the server said to the user (`window/showMessage`). */
export function lspSaid(key: string): string | null {
  return state.said[key] ?? null;
}

/**
 * The server for `req`, started if it is not running: the client connected to
 * it, or null — not installed (`missing`) or failed. Every acquire is paired
 * with a `release` of the same key.
 */
export function acquireLsp(req: LspRequest): Promise<LspHandle | null> {
  const key = lspEntryKey(req);
  const have = live.get(key);
  if (have) {
    have.refs++;
    return have.handle;
  }
  if (state.status[key] === "missing") return Promise.resolve(null);
  state.status[key] = "starting";
  const entry: Live = { req, id: null, handle: Promise.resolve(null), refs: 1, unlisten: [] };
  live.set(key, entry);
  entry.handle = start(key, entry);
  return entry.handle;
}

async function start(key: string, entry: Live): Promise<LspHandle | null> {
  const { req } = entry;
  try {
    const res = await lspStart(req.sessionId, req.local, req.server, req.root);
    if (!res.found || !res.id) {
      live.delete(key);
      state.status[key] = "missing";
      return null;
    }
    const id = res.id;
    entry.id = id;
    const handlers = new Set<(m: string) => void>();
    entry.unlisten.push(await onLspMessage(id, (m) => handlers.forEach((h) => h(m))));
    entry.unlisten.push(
      await onLspClosed(id, (c) => {
        if (live.get(key) !== entry) return;
        live.delete(key);
        entry.unlisten.forEach((u) => u());
        state.status[key] = c.asked ? "stopped" : "failed";
      }),
    );
    // Stopped while it was starting: let it go at once.
    if (live.get(key) !== entry) {
      void lspStop(id).catch(swallow("editor", "a language server let go while starting was not stopped"));
      return null;
    }
    const handle = await connectClient(
      {
        send: (m) => void lspSend(id, m).catch(swallow("editor", "a message to the language server was not sent")),
        subscribe: (h) => handlers.add(h),
        unsubscribe: (h) => handlers.delete(h),
      },
      rootUri(req.root),
      (_kind, text) => (state.said[key] = text),
    );
    await handle.ready;
    if (live.get(key) === entry) state.status[key] = "running";
    return handle;
  } catch (e) {
    diag.warn("editor", "a language server did not start: the editor works without its hints", { server: req.server });
    if (live.get(key) === entry) {
      live.delete(key);
      entry.unlisten.forEach((u) => u());
      if (entry.id) void lspStop(entry.id).catch(swallow("editor", "a language server that failed to start was not stopped"));
    }
    state.status[key] = "failed";
    state.said[key] = String(e instanceof Error ? e.message : e).slice(0, 300);
    return null;
  }
}

function rootUri(root: string): string {
  const p = root.replace(/\\/g, "/");
  return "file://" + (/^[A-Za-z]:/.test(p) ? `/${p}` : p).split("/").map((s) => encodeURIComponent(s).replace(/%3A/g, ":")).join("/");
}

/** One editor lets go of its server; the last one stops it. */
export function releaseLsp(req: LspRequest): void {
  const key = lspEntryKey(req);
  const entry = live.get(key);
  if (!entry || --entry.refs > 0) return;
  stopEntry(key, entry);
}

function stopEntry(key: string, entry: Live) {
  live.delete(key);
  state.status[key] = "stopped";
  void entry.handle.then((h) => h?.close()).catch(swallow("editor", "a language server's client did not disconnect"));
  entry.unlisten.forEach((u) => u());
  if (entry.id) void lspStop(entry.id).catch(swallow("editor", "a language server was not stopped: it ends with its session"));
}

/** Stop a running server by hand (the status bar), whoever holds it. */
export function stopLsp(req: LspRequest): void {
  const key = lspEntryKey(req);
  const entry = live.get(key);
  if (entry) stopEntry(key, entry);
}

/** A tab closed: its servers stop and what was learned of them goes (`closeTabFully`). */
export function forgetLsp(sessionId: string): void {
  for (const [key, entry] of [...live.entries()]) if (entry.req.sessionId === sessionId) stopEntry(key, entry);
  for (const key of Object.keys(state.status)) {
    if (key.startsWith(`${sessionId}|`)) {
      delete state.status[key];
      delete state.said[key];
    }
  }
}

/** Forget that a server was not installed for the tab (it may be now): the next start looks again. */
export function forgetMissing(req: LspRequest): void {
  const key = lspEntryKey(req);
  if (state.status[key] === "missing") delete state.status[key];
}
