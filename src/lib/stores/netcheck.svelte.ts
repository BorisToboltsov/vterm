// Access-check store (v1.0.36): the rules draft and the per-host history of the
// Utilities "access check". The Utilities panel unmounts on close, so the draft
// lives here to survive a reopen. Keyed by the checking HOST (server address or
// "local"), not by session: history outlives tabs, so nothing here needs
// clearing in `closeTabFully`. Persisted to localStorage (per-viewer
// convenience; losing it only loses suggestions).
import {
  pushHistory,
  sanitizeHistory,
  sanitizeMethods,
  type MethodChoice,
  type NetHistory,
} from "../netcheck";

const STORAGE_KEY = "vterm.netcheck";
// The probe method picked per checking host (v1.0.37); "auto" isn't stored.
const METHOD_KEY = "vterm.netcheck.method";

function loadMethods(): Record<string, MethodChoice> {
  try {
    return sanitizeMethods(JSON.parse(localStorage.getItem(METHOD_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function load(): NetHistory {
  try {
    return sanitizeHistory(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export const netcheckState = $state<{
  draft: string;
  history: NetHistory;
  methods: Record<string, MethodChoice>;
}>({
  draft: "",
  history: load(),
  methods: loadMethods(),
});

/** The method picked for `host` ("auto" when none was). */
export function methodFor(host: string): MethodChoice {
  return netcheckState.methods[host] ?? "auto";
}

/** Remember the method picked for `host`. */
export function setMethod(host: string, choice: MethodChoice): void {
  if (!host) return;
  const next = { ...netcheckState.methods };
  if (choice === "auto") delete next[host];
  else next[host] = choice;
  netcheckState.methods = next;
  try {
    localStorage.setItem(METHOD_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — the choice just won't persist */
  }
}

/** Remember a rule set that was run from `host`. */
export function rememberRules(host: string, text: string): void {
  netcheckState.history = pushHistory(netcheckState.history, host, text);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(netcheckState.history));
  } catch {
    /* storage blocked — history just won't persist */
  }
}
