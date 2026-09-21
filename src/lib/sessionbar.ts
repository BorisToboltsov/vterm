// The per-tab session bar under the server tabs: workspace sub-tabs (terminal +
// open editors) on the left, terminal tools on the right (full-buffer search,
// Raw ↔ Table). It replaced the Raw/Table switch that floated over the top-right
// of the terminal — there it covered the first row of full-screen programs
// (nano's title line, htop's header).
//
// Which parts show is pure logic here; the bar itself (+page.svelte) only lays
// them out. The bar is not rendered at all when every part is off, so a plain
// terminal with smart logs disabled keeps its full height.

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
}

export interface SessionBarParts {
  subtabs: boolean;
  search: boolean;
  viewToggle: boolean;
}

export function sessionBarParts(i: SessionBarInput): SessionBarParts {
  if (i.broadcast) return { subtabs: false, search: false, viewToggle: false };
  const tools = i.onTerminal && i.connected && i.smartLogs;
  return {
    subtabs: i.editors > 0,
    search: tools && !i.structured,
    viewToggle: tools,
  };
}

/** Whether the bar renders at all. */
export function showSessionBar(p: SessionBarParts): boolean {
  return p.subtabs || p.search || p.viewToggle;
}
