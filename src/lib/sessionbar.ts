// The session bar over a terminal: its tools — full-buffer search, Raw ↔ Table,
// clear, ask the assistant about the selection. It replaced the Raw/Table switch
// that floated over the top-right of the terminal — there it covered the first
// row of full-screen programs (nano's title line, htop's header). While the
// connection has files open, the tools stand at the right end of the strip of
// views of the zone that shows the terminal (v1.11) — one row, not two.
//
// Which parts show is pure logic here; the bar itself (+page.svelte) only lays
// them out. "Clear" belongs to every live terminal, so the bar is always there for
// one; it is not rendered at all only when every part is off (an unconnected
// tab). Clear and Ask AI moved here from the right-click menu, which became
// paste by default (termmouse.ts).

export interface SessionBarInput {
  /** The session is live — the tools act on its buffer / output stream. */
  connected: boolean;
  /** Master smart-logs switch; gates both search and the structured view. */
  smartLogs: boolean;
  /** The structured (table) view is open; buffer search doesn't apply to it. */
  structured: boolean;
  /** The assistant is configured and this server is not `noAi`. */
  ai: boolean;
}

export interface SessionBarParts {
  search: boolean;
  viewToggle: boolean;
  clear: boolean;
  askAi: boolean;
}

export function sessionBarParts(i: SessionBarInput): SessionBarParts {
  const live = i.connected;
  const tools = live && i.smartLogs;
  // The table covers the raw buffer: clearing or asking about a selection you
  // can't see would act on something off-screen.
  const raw = live && !i.structured;
  return {
    search: tools && !i.structured,
    viewToggle: tools,
    clear: raw,
    askAi: raw && i.ai,
  };
}

/** Whether the bar renders at all. */
export function showSessionBar(p: SessionBarParts): boolean {
  return p.search || p.viewToggle || p.clear || p.askAi;
}
