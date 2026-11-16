// Language servers over the session's transport (ADR 0079): start one of the
// catalogue in a project folder, talk to it, stop it. Its messages arrive on
// `lsp://msg/{id}`, its end on `lsp://closed/{id}` — events named by the id, so
// any window may listen.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { call } from "./call";

export interface LspStart {
  id: string | null;
  /** False: the server is not installed where the project lives. */
  found: boolean;
}

export interface LspClosed {
  code: number | null;
  /** It ended because it was asked to. */
  asked: boolean;
}

/** Start `server` in `root`: on the session's server, or on this computer when `local`. */
export function lspStart(sessionId: string, local: boolean, server: string, root: string): Promise<LspStart> {
  return call<LspStart>("lsp_start", { sessionId, local, server, root });
}

export function lspSend(id: string, message: string): Promise<void> {
  return call<void>("lsp_send", { id, message });
}

export function lspStop(id: string): Promise<void> {
  return call<void>("lsp_stop", { id });
}

export function onLspMessage(id: string, handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>(`lsp://msg/${id}`, (e) => handler(e.payload));
}

export function onLspClosed(id: string, handler: (closed: LspClosed) => void): Promise<UnlistenFn> {
  return listen<LspClosed>(`lsp://closed/${id}`, (e) => handler(e.payload));
}
