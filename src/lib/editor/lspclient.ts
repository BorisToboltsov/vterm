// The language server client of the editor (ADR 0079): CodeMirror's own
// `@codemirror/lsp-client`, loaded when a server is first started. The
// transport is the backend's (`lsp_send` and the `lsp://msg/{id}` events) and is
// handed in — this module talks to no backend itself. Whatever the server's
// Markdown becomes passes `sanitizeLspHtml` before it reaches the page.

import type { Extension } from "@codemirror/state";
import { sanitizeLspHtml } from "./lspsanitize";

/** How messages reach the server and come back. */
export interface LspTransport {
  send(message: string): void;
  subscribe(handler: (message: string) => void): void;
  unsubscribe(handler: (message: string) => void): void;
}

/** A connected client: an editor's extension for one of its files, and the way to let go. */
export interface LspHandle {
  /** Resolves once the server has answered `initialize` (rejects when it does not). */
  ready: Promise<unknown>;
  extension(uri: string, languageId: string): Extension;
  /** Let go of the server (the client stops talking; the backend stops the process). */
  close(): void;
}

/** What a server says to the user (`window/showMessage`): its kind and text. */
export type ServerSay = (kind: "error" | "warning" | "info", text: string) => void;

export async function connectClient(transport: LspTransport, rootUri: string, say: ServerSay): Promise<LspHandle> {
  const { LSPClient, languageServerExtensions } = await import("@codemirror/lsp-client");
  const client = new LSPClient({
    rootUri,
    timeout: 10_000,
    sanitizeHTML: sanitizeLspHtml,
    extensions: languageServerExtensions(),
    notificationHandlers: {
      // The server's own log stays with the server; nothing reads the console.
      "window/logMessage": () => true,
      "window/showMessage": (_c, params: { type?: number; message?: string }) => {
        const kind = params.type === 1 ? "error" : params.type === 2 ? "warning" : "info";
        if (params.message) say(kind, params.message.slice(0, 500));
        return true;
      },
    },
  }).connect(transport);
  return {
    ready: client.initializing,
    extension: (uri, languageId) => client.plugin(uri, languageId),
    close: () => client.disconnect(),
  };
}
