// Terminal-tabs store (Svelte 5 runes): owns the list of open connection tabs
// and which one is active, plus the operations that mutate them. Connection /
// secret orchestration stays in the page; this store is pure tab bookkeeping.

import { t } from "../i18n";

export interface Tab {
  sessionId: string;
  /** "ssh" = remote server connection; "local" = local shell PTY. */
  kind: "ssh" | "local";
  /** SSH only: the server profile id ("" for local tabs). */
  serverId: string;
  /** Snapshot of the server alias at open time (UI falls back to it). */
  alias: string;
  /** Just-typed secret, or null to use the keychain (unused for local). */
  secret: string | null;
  remember: boolean;
  /** Human-readable status label (see statusLabel). */
  status: string;
  /** Bumped to force the terminal to remount and reconnect. */
  gen: number;
}

export type TabStatus = "connecting" | "connected" | "closed" | "error";

/** Map a raw status + optional detail to the label shown on a tab. */
export function statusLabel(st: TabStatus, detail?: string): string {
  switch (st) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "closed":
      return "Disconnected";
    default:
      return `Error: ${detail ?? "unknown"}`;
  }
}

/**
 * Localize a canonical status label (as produced by `statusLabel`) for display.
 * The stored `status` stays in English so the `startsWith(…)` logic checks below
 * keep working regardless of UI language; this maps it to the current language
 * only at render time. Reactive: reads the language via `t()`.
 */
export function localizedStatus(statusText: string): string {
  if (statusText.startsWith("Connecting") || statusText === "connecting")
    return t("status.connecting");
  if (statusText.startsWith("Connected")) return t("status.connected");
  if (statusText.startsWith("Disconnected")) return t("status.disconnected");
  if (statusText.startsWith("Error"))
    return t("status.error", { detail: statusText.replace(/^Error:\s*/, "") });
  return t("status.notConnected");
}

/** Tailwind colour class for a tab's status dot. */
export function dotClass(statusText: string): string {
  if (statusText.startsWith("Connected")) return "bg-green-500";
  if (statusText.startsWith("Connecting")) return "bg-yellow-500";
  if (statusText.startsWith("Error")) return "bg-danger";
  return "bg-muted";
}

/** True while a tab's session is live (connected or connecting). */
export const isLive = (status: string): boolean =>
  status.startsWith("Connected") || status.startsWith("Connecting");

/** What a Cmd/Ctrl+T should open (Phase 20.15). */
export type NewTabAction = { kind: "ssh"; serverId: string } | { kind: "local" };

/**
 * Decide what Cmd/Ctrl+T opens: a fresh tab of the active server when the active
 * tab is an SSH session, otherwise a local shell — which also covers the case where
 * no tab is open (`activeTab` is null). Pure so the decision is unit-tested without
 * the DOM/store; the page resolves the server id and does the actual open (ADR 0003).
 */
export function newTabAction(
  activeTab: Pick<Tab, "kind" | "serverId"> | null | undefined,
): NewTabAction {
  if (activeTab?.kind === "ssh") return { kind: "ssh", serverId: activeTab.serverId };
  return { kind: "local" };
}

/** Severity order for the server-row dots: problems first so a dropped/erroring
 *  connection is never the one hidden by the cap. Error → connecting → connected. */
function statusRank(statusText: string): number {
  if (statusText.startsWith("Error")) return 0;
  if (statusText.startsWith("Connecting")) return 1;
  if (statusText.startsWith("Connected")) return 2;
  return 3;
}

/** A single overlapping connection dot in the tree. */
export interface StatusDot {
  /** Fill colour + a thin (1px) tonal ring in the same hue (`ring-1 ring-[…]`). */
  cls: string;
  /** True for a connecting tab — the dot gently breathes (pulses). */
  pulse: boolean;
}

/** Fill + tonal-ring classes and pulse flag for one tab status. The ring is a
 *  darker shade of the fill so overlapping dots separate softly (no harsh edge). */
function dotStyle(statusText: string): StatusDot {
  if (statusText.startsWith("Connected"))
    return { cls: "bg-green-500 ring-1 ring-[#166534]", pulse: false };
  if (statusText.startsWith("Connecting"))
    return { cls: "bg-yellow-500 ring-1 ring-[#854d0e]", pulse: true };
  if (statusText.startsWith("Error"))
    return { cls: "bg-danger ring-1 ring-[#7d3350]", pulse: false };
  return { cls: "bg-muted ring-1 ring-[#3f3f5a]", pulse: false };
}

/**
 * Overlapping status dots for a server row in the tree, from the statuses of its
 * open SSH tabs (in tab order — newest last). Displayed in **tab order** so a
 * newly opened tab's dot appears at the end of the stack, not reshuffled to the
 * front. When there are more than `max`, the ones shown are picked severity-first
 * (so an error/drop is never the one hidden), but still rendered in tab order;
 * the remainder is reported as `extra` (rendered "+N").
 */
export function serverDots(
  statuses: string[],
  max = 3,
): { dots: StatusDot[]; extra: number } {
  const shown = statuses
    .map((s, i) => ({ s, i }))
    .sort((a, b) => statusRank(a.s) - statusRank(b.s)) // pick which to show…
    .slice(0, max)
    .sort((a, b) => a.i - b.i); // …but render in tab order (newest last)
  return {
    dots: shown.map(({ s }) => dotStyle(s)),
    extra: Math.max(0, statuses.length - max),
  };
}

/**
 * Roving keyboard navigation for the tab bar (a11y): given the current index,
 * how many tabs there are and the pressed key, return the index to move to —
 * or `null` when the key isn't a navigation key (or there are no tabs). Arrows
 * wrap around; Home/End jump to the ends.
 */
export function nextTabIndex(current: number, len: number, key: string): number | null {
  if (len === 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % len;
    case "ArrowLeft":
      return (current - 1 + len) % len;
    case "Home":
      return 0;
    case "End":
      return len - 1;
    default:
      return null;
  }
}

export const tabsState = $state<{ list: Tab[]; activeId: string | null }>({
  list: [],
  activeId: null,
});

export const findTab = (sessionId: string | null): Tab | null =>
  tabsState.list.find((t) => t.sessionId === sessionId) ?? null;

/** Open a new tab for `serverId` and make it active; returns its sessionId. */
export function openTab(
  serverId: string,
  alias: string,
  secret: string | null,
  remember: boolean,
): string {
  const tab: Tab = {
    sessionId: crypto.randomUUID(),
    kind: "ssh",
    serverId,
    alias,
    secret,
    remember,
    status: "connecting",
    gen: 0,
  };
  tabsState.list = [...tabsState.list, tab];
  tabsState.activeId = tab.sessionId;
  return tab.sessionId;
}

/** Open a local-shell terminal tab (PTY on the machine running vterm). */
export function openLocalTab(): string {
  const tab: Tab = {
    sessionId: crypto.randomUUID(),
    kind: "local",
    serverId: "",
    alias: "Local shell",
    secret: null,
    remember: false,
    status: "connecting",
    gen: 0,
  };
  tabsState.list = [...tabsState.list, tab];
  tabsState.activeId = tab.sessionId;
  return tab.sessionId;
}

/** Remove a tab; if it was active, focus the neighbour that takes its slot. */
export function closeTab(sessionId: string): void {
  const idx = tabsState.list.findIndex((t) => t.sessionId === sessionId);
  if (idx === -1) return;
  tabsState.list = tabsState.list.filter((t) => t.sessionId !== sessionId);
  if (tabsState.activeId === sessionId) {
    tabsState.activeId =
      tabsState.list[idx]?.sessionId ?? tabsState.list[idx - 1]?.sessionId ?? null;
  }
}

/** Re-open a tab's connection in place (reuses its credentials). */
export function reconnectTab(sessionId: string): void {
  tabsState.list = tabsState.list.map((t) =>
    t.sessionId === sessionId
      ? { ...t, status: "Connecting…", gen: t.gen + 1 }
      : t,
  );
}

/** Set a tab's status from a raw status + detail. */
export function setTabStatus(sessionId: string, st: TabStatus, detail?: string): void {
  const label = statusLabel(st, detail);
  tabsState.list = tabsState.list.map((t) =>
    t.sessionId === sessionId ? { ...t, status: label } : t,
  );
}

/** Move the dragged tab so it sits at index `to` (used by drag-to-reorder). */
export function moveTab(sessionId: string, to: number): void {
  const from = tabsState.list.findIndex((t) => t.sessionId === sessionId);
  if (from === -1 || to < 0 || to >= tabsState.list.length || from === to) return;
  const next = [...tabsState.list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  tabsState.list = next;
}

/** Remove every tab belonging to a server (e.g. when it is deleted). */
export function closeTabsForServer(serverId: string): void {
  for (const t of tabsState.list.filter((t) => t.serverId === serverId)) {
    closeTab(t.sessionId);
  }
}
