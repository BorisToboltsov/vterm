// The per-tab session bar under the server tabs: workspace sub-tabs (terminal +
// open editors) on the left, terminal tools on the right (full-buffer search,
// Raw ↔ Table, clear, ask the assistant about the selection). It replaced the Raw/Table switch that floated over the top-right
// of the terminal — there it covered the first row of full-screen programs
// (nano's title line, htop's header).
//
// Which parts show is pure logic here; the bar itself (+page.svelte) only lays
// them out. "Clear" belongs to every live terminal, so the bar is always there for
// one; it is not rendered at all only when every part is off (an unconnected tab,
// broadcast). Clear and Ask AI moved here from the right-click menu, which became
// paste by default (termmouse.ts).

export interface SessionBarInput {
  /** Open editor documents in this tab's workspace. */
  editors: number;
  /** The terminal (not an editor) is the active view of the workspace. */
  onTerminal: boolean;
  /** The session is live — the tools act on its buffer / output stream. */
  connected: boolean;
  /** Master smart-logs switch; gates both search and the structured view. */
  smartLogs: boolean;
  /** The structured (table) view is open; buffer search doesn't apply to it. */
  structured: boolean;
  /** Broadcast mode lays tiles out on its own and hides the per-tab bar. */
  broadcast: boolean;
  /** The assistant is configured and this server is not `noAi`. */
  ai: boolean;
}

export interface SessionBarParts {
  subtabs: boolean;
  search: boolean;
  viewToggle: boolean;
  clear: boolean;
  askAi: boolean;
}

export function sessionBarParts(i: SessionBarInput): SessionBarParts {
  if (i.broadcast) {
    return { subtabs: false, search: false, viewToggle: false, clear: false, askAi: false };
  }
  const live = i.onTerminal && i.connected;
  const tools = live && i.smartLogs;
  // The table covers the raw buffer: clearing or asking about a selection you
  // can't see would act on something off-screen.
  const raw = live && !i.structured;
  return {
    subtabs: i.editors > 0,
    search: tools && !i.structured,
    viewToggle: tools,
    clear: raw,
    askAi: raw && i.ai,
  };
}

/** Whether the bar renders at all. */
export function showSessionBar(p: SessionBarParts): boolean {
  return p.subtabs || p.search || p.viewToggle || p.clear || p.askAi;
}
