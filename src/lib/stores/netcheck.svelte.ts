// Access-check store (v1.0.36): the rules draft and the per-host history of the
// Utilities "access check". The Utilities panel unmounts on close, so the draft
// lives here to survive a reopen. Keyed by the checking HOST (server address or
// "local"), not by session: history outlives tabs, so nothing here needs
// clearing in `closeTabFully`. Persisted to localStorage (per-viewer
// convenience; losing it only loses suggestions).
import { pushHistory, sanitizeHistory, type NetHistory } from "../netcheck";

const STORAGE_KEY = "vterm.netcheck";

function load(): NetHistory {
  try {
    return sanitizeHistory(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export const netcheckState = $state<{ draft: string; history: NetHistory }>({
  draft: "",
  history: load(),
});

/** Remember a rule set that was run from `host`. */
export function rememberRules(host: string, text: string): void {
  netcheckState.history = pushHistory(netcheckState.history, host, text);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(netcheckState.history));
  } catch {
    /* storage blocked — history just won't persist */
  }
}
