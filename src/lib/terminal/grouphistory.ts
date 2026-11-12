// The history of synchronous input (ADR 0064): what the group's command line
// sent, and what its members' shells remember. The line recalls its own sends
// with ↑/↓ and searches everything with Ctrl+R (⌘R on macOS).
//
// Resolved here, in the app, and never by the shells: ↑ typed into four shells
// recalls four different commands — each its own history — and Enter would run
// them. A command recalled here is one text, the same for every member.
//
// DOM-free (ADR 0003): the bar keeps the state, this module decides.

/** How many sent commands the line remembers (newest kept). */
export const SENT_CAP = 500;

/** A command the line sent, and the sessions it went to. */
export interface SentCommand {
  cmd: string;
  /** Session ids it was typed into, every time it was sent. */
  to: string[];
}

/**
 * A command the shells keep out of their history is kept out of this one too:
 * a leading space is the `HISTCONTROL=ignorespace` / `HIST_IGNORE_SPACE` way to
 * say so (often for a command that carries a secret), and blank is nothing.
 */
export function keptOutOfHistory(cmd: string): boolean {
  return cmd.trim() === "" || /^\s/.test(cmd);
}

/** The list after `cmd` went to `to`: newest first, each command once, at most `cap`. */
export function rememberSent(
  list: readonly SentCommand[],
  cmd: string,
  to: readonly string[],
  cap = SENT_CAP,
): SentCommand[] {
  if (keptOutOfHistory(cmd)) return [...list];
  const before = list.find((s) => s.cmd === cmd);
  const sentTo = [...new Set([...(before?.to ?? []), ...to])];
  return [{ cmd, to: sentTo }, ...list.filter((s) => s.cmd !== cmd)].slice(0, Math.max(0, cap));
}

/** Drop a closed session from where the sent commands went. */
export function forgetSession(list: readonly SentCommand[], sessionId: string): SentCommand[] {
  return list.map((s) => (s.to.includes(sessionId) ? { ...s, to: s.to.filter((id) => id !== sessionId) } : s));
}

// ── ↑/↓ in the line ─────────────────────────────────────────────────────────

/** Where the line's recall stands: `at` −1 is the user's own text (`draft`). */
export interface Recall {
  at: number;
  /** What the user had typed before the first ↑ — the prefix searched for, and what ↓ returns to. */
  draft: string;
}

export const NO_RECALL: Recall = { at: -1, draft: "" };

/**
 * One step of ↑ (`older`) or ↓ (`newer`) over `commands` (newest first), with
 * `current` the line's text now. With text typed before the first ↑, only the
 * commands starting with it are stepped through — zsh's and fish's habit. Past
 * the newest, ↓ gives the draft back. Null: there is nowhere to go (the line stays).
 */
export function recall(
  commands: readonly string[],
  state: Recall,
  current: string,
  dir: "older" | "newer",
): { state: Recall; text: string } | null {
  const draft = state.at === -1 ? current : state.draft;
  const fits = (cmd: string) => cmd.startsWith(draft) && cmd !== draft;
  if (dir === "older") {
    for (let i = state.at + 1; i < commands.length; i++) {
      if (fits(commands[i])) return { state: { at: i, draft }, text: commands[i] };
    }
    return null;
  }
  if (state.at === -1) return null;
  for (let i = state.at - 1; i >= 0; i--) {
    if (fits(commands[i])) return { state: { at: i, draft }, text: commands[i] };
  }
  return { state: { at: -1, draft }, text: draft };
}

// ── Ctrl+R: the group's history ─────────────────────────────────────────────

/** A member's shell history as read: newest first, or null when it could not be read. */
export interface HostHistory {
  id: string;
  label: string;
  commands: string[] | null;
}

/** A line of the group's history search. */
export interface GroupRow {
  cmd: string;
  /** Sent by the group's line this run. */
  sent: boolean;
  /** Labels of the members that ran it or keep it in their history. */
  on: string[];
  /** Members in the group. */
  of: number;
}

/**
 * The group's history, for the search: what the line sent first (newest first),
 * then what the members' shells remember — by how recently any of them ran it,
 * the commands more members share first among equals. A member "has" a command
 * when its history keeps it or the line sent it there: a bash history is
 * written only when the shell exits, and the line knows what it typed.
 */
export function groupRows(sent: readonly SentCommand[], hosts: readonly HostHistory[]): GroupRow[] {
  const of = hosts.length;
  const onOf = (cmd: string, sentTo: readonly string[]): string[] =>
    hosts.filter((h) => sentTo.includes(h.id) || (h.commands?.includes(cmd) ?? false)).map((h) => h.label);
  const rows: GroupRow[] = sent.map((s) => ({ cmd: s.cmd, sent: true, on: onOf(s.cmd, s.to), of }));
  const seen = new Set(sent.map((s) => s.cmd));
  const rank = new Map<string, number>();
  for (const h of hosts) {
    (h.commands ?? []).forEach((cmd, i) => {
      if (seen.has(cmd)) return;
      rank.set(cmd, Math.min(rank.get(cmd) ?? Infinity, i));
    });
  }
  const rest = [...rank.keys()].map((cmd) => ({ cmd, sent: false, on: onOf(cmd, []), of }));
  rest.sort(
    (a, b) =>
      (rank.get(a.cmd) ?? 0) - (rank.get(b.cmd) ?? 0) || b.on.length - a.on.length || a.cmd.localeCompare(b.cmd),
  );
  return [...rows, ...rest];
}

/** The group's history as the line's search shows it. */
export interface GroupHistoryView {
  open: boolean;
  loading: boolean;
  rows: GroupRow[];
  /** Members whose shell history could not be read. */
  unread: string[];
  /** Members in the group. */
  members: number;
}

export const CLOSED_HISTORY: GroupHistoryView = { open: false, loading: false, rows: [], unread: [], members: 0 };

/** Which of the group's history the search shows. */
export type HistoryFacet = "all" | "everywhere" | "sent";

export const HISTORY_FACETS: readonly HistoryFacet[] = ["all", "everywhere", "sent"];

export function facetRows(rows: readonly GroupRow[], facet: HistoryFacet): GroupRow[] {
  if (facet === "sent") return rows.filter((r) => r.sent);
  if (facet === "everywhere") return rows.filter((r) => r.of > 0 && r.on.length === r.of);
  return [...rows];
}

/** The members whose history could not be read — named under the list, not left out silently. */
export function unreadHosts(hosts: readonly HostHistory[]): string[] {
  return hosts.filter((h) => h.commands === null).map((h) => h.label);
}
