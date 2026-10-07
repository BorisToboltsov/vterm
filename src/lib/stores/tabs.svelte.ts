// Terminal-tabs store (Svelte 5 runes): owns the list of open connection tabs
// and where each one stands in the centre — the tree of panes (`../splitlayout.ts`)
// and the pane in focus. Connection / secret orchestration stays in the page;
// this store is pure tab bookkeeping.
//
// **"The active tab" is the tab shown by the pane in focus** (v1.2). It is derived
// from the layout, never stored: with two terminals side by side "the tab on
// screen" is no longer one tab, and a second, writable `activeId` would be free to
// disagree with the tree. Everything that follows one session — the docks, the
// status bar, the assistant's context — reads `tabsState.activeId`; whoever wants
// to change it calls `activateTab` / `focusPane`.
//
// The layout is only ever replaced with a result of the pure model
// (`centerlayout.guard`). It is not persisted: tabs are not restored on restart,
// so there is nothing for a saved centre to hold.

import { t } from "../i18n";
import {
  activateTab as activateTabIn,
  activeTab as activeTabIn,
  addTab,
  applyDrop,
  emptyLayout,
  focusPane as focusPaneIn,
  joinPanes as joinPanesIn,
  moveTab as moveTabIn,
  placeTab,
  removeTab,
  setRatio,
  splitWithTab,
  type CenterLayout,
  type Edge,
  type TabDrop,
} from "../splitlayout";
import type { TabAttach } from "../tabattach";
import type { TermSnapshot } from "../tabhandoff";

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
  /** Set when the tab is a shell INTO a container/pod (tabattach.ts): its argv
   *  runs on every connect, and the tab's shell ends with it. */
  attach?: TabAttach;
  /**
   * Set on a tab that arrived from another window (ADR 0017): its session is
   * already live, so its terminal restores this snapshot and takes the session
   * over instead of connecting. Cleared once it has — a later reconnect is an
   * ordinary one.
   */
  adopt?: TermSnapshot;
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

/**
 * What the right dock can say about a tab's session. `offline` covers both a
 * dropped connection (keepalive timeout, network gone, server went away) and a
 * connect that never succeeded: in either case there is no session for the
 * panels to run commands on, so they must say so rather than keep showing a
 * listing that silently ages or a "checking…" that never resolves.
 */
export type DockConnection = "connecting" | "connected" | "offline";

export function dockConnection(status: string): DockConnection {
  if (status.startsWith("Connected")) return "connected";
  if (status.startsWith("Connecting") || status === "connecting") return "connecting";
  return "offline";
}

/**
 * Whether a tab exposes host metrics — gates the bottom status bar and the
 * monitoring overlay. Both SSH **and** local tabs qualify once connected (Phase
 * 38): a local tab has no SSH probe, but the backend reports its metrics natively
 * via `sysinfo`. Broader than the old SSH-only gate; narrower than `isLive`
 * (metrics need a live session, not one still connecting).
 */
export const isMonitorable = (
  tab: Pick<Tab, "kind" | "status"> | null | undefined,
): boolean =>
  !!tab && (tab.kind === "ssh" || tab.kind === "local") && tab.status.startsWith("Connected");

/**
 * The session whose metrics the idle screensaver's card polls: the active tab's,
 * whenever the status bar could show them (`isMonitorable`), else null (the card
 * then says "no active sessions"). One gate for both, so a local tab no longer
 * gets a live status bar but an empty screensaver.
 */
export const monitoredSessionId = (
  tab: Pick<Tab, "kind" | "status" | "sessionId"> | null | undefined,
): string | null => (tab && isMonitorable(tab) ? tab.sessionId : null);

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

let list = $state<Tab[]>([]);
// Raw: the tree is replaced whole by the pure model, never edited in place.
let center = $state.raw<CenterLayout>(emptyLayout());

export const tabsState = {
  /**
   * Every open tab, in the order they were opened. Which pane a tab is in and
   * where it stands in that pane's strip is the layout's business (`center`).
   */
  get list(): Tab[] {
    return list;
  },
  /** The centre: the tree of panes and the pane in focus. */
  get center(): CenterLayout {
    return center;
  },
  /** The session in focus — the tab shown by the focused pane; null for an empty pane. */
  get activeId(): string | null {
    return activeTabIn(center);
  },
};

/** Close everything and forget the layout (tests). */
export function resetTabs(): void {
  list = [];
  center = emptyLayout();
}

export const findTab = (sessionId: string | null): Tab | null =>
  list.find((t) => t.sessionId === sessionId) ?? null;

/** Open a new tab for `serverId` in the focused pane and show it; returns its sessionId. */
export function openTab(
  serverId: string,
  alias: string,
  secret: string | null,
  remember: boolean,
  attach?: TabAttach,
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
    attach,
  };
  list = [...list, tab];
  center = addTab(center, tab.sessionId);
  return tab.sessionId;
}

/** Open a local-shell terminal tab (PTY on the machine running vterm). */
export function openLocalTab(attach?: TabAttach): string {
  const tab: Tab = {
    sessionId: crypto.randomUUID(),
    kind: "local",
    serverId: "",
    alias: "Local shell",
    secret: null,
    remember: false,
    status: "connecting",
    gen: 0,
    attach,
  };
  list = [...list, tab];
  center = addTab(center, tab.sessionId);
  return tab.sessionId;
}

/**
 * Add a tab that was moved here from another window (ADR 0017) and show it:
 * where it was dropped (`drop` — ADR 0018), or, moved by a command, in the
 * focused pane. Its session id, status and credentials are the ones it had;
 * `terminal` is what its terminal restores before taking the session over.
 * A tab that is already here is left alone.
 */
export function adoptTab(tab: Tab, terminal: TermSnapshot, drop: TabDrop | null = null): void {
  if (list.some((t) => t.sessionId === tab.sessionId)) return;
  list = [...list, { ...tab, gen: 0, adopt: terminal }];
  center = placeTab(center, tab.sessionId, drop);
}

/** The adopted terminal took its session over: the snapshot has served. */
export function clearAdopt(sessionId: string): void {
  if (!list.some((t) => t.sessionId === sessionId && t.adopt)) return;
  list = list.map((t) => {
    if (t.sessionId !== sessionId) return t;
    const { adopt: _used, ...rest } = t;
    return rest;
  });
}

/**
 * Remove a tab from the list and from its pane; the pane shows the neighbour
 * that takes its slot, and a pane left empty goes with it.
 *
 * **This is the list operation only — not "close a session".** A tab owns state
 * in other stores (workspace/editors, AI conversation, broadcast membership) and
 * dropping the row without dropping those leaks the editors' contents and the
 * chat history, and leaves a dead session id in the broadcast set. The full
 * teardown is `closeTabFully` in `+page.svelte`, which is the only caller —
 * enforced by `tabteardown.guard.test.ts`. A bulk variant used to live here and
 * was exactly how server deletion bypassed the teardown.
 */
export function closeTab(sessionId: string): void {
  if (!list.some((t) => t.sessionId === sessionId)) return;
  list = list.filter((t) => t.sessionId !== sessionId);
  center = removeTab(center, sessionId);
}

/** Re-open a tab's connection in place (reuses its credentials). */
export function reconnectTab(sessionId: string): void {
  list = list.map((t) => {
    if (t.sessionId !== sessionId) return t;
    // A fresh connection, even for a tab that came from another window.
    const { adopt: _stale, ...rest } = t;
    return { ...rest, status: "Connecting…", gen: t.gen + 1 };
  });
}

/** Set a tab's status from a raw status + detail. */
export function setTabStatus(sessionId: string, st: TabStatus, detail?: string): void {
  const label = statusLabel(st, detail);
  list = list.map((t) => (t.sessionId === sessionId ? { ...t, status: label } : t));
}

// ── The centre: panes and focus ──────────────────────────────────────────────

/** Show a tab in its pane and give that pane the focus. */
export function activateTab(sessionId: string): void {
  center = activateTabIn(center, sessionId);
}

/** Give a pane the focus (a click or a keystroke inside it). */
export function focusPane(paneId: string): void {
  center = focusPaneIn(center, paneId);
}

/** Move a tab to a pane (or reorder it in its own); `index` omitted = last. */
export function moveTabTo(sessionId: string, paneId: string, index?: number | null): void {
  center = moveTabIn(center, sessionId, paneId, index);
}

/** Drop a dragged tab where the pointer left it. */
export function dropTab(sessionId: string, drop: TabDrop): void {
  center = applyDrop(center, sessionId, drop);
}

/**
 * Move a tab into a new pane at `edge` of pane `paneId` — the only way a pane
 * comes to be. A pane goes when its last tab leaves; there is no empty pane to
 * open or close.
 */
export function splitTabOff(sessionId: string, paneId: string, edge: Edge): void {
  center = splitWithTab(center, sessionId, paneId, edge);
}

/** Undo every split: all tabs back in one pane. */
export function joinPanes(): void {
  center = joinPanesIn(center);
}

/** Resize the two halves of a split. */
export function setSplitRatio(splitId: string, ratio: number): void {
  center = setRatio(center, splitId, ratio);
}

/**
 * Session ids of every tab belonging to `serverId` (e.g. the tabs a server
 * deletion has to close).
 *
 * Deliberately returns ids instead of closing them: the closing half must go
 * through the full teardown, and a store-level `closeTabsForServer` could not do
 * that without depending on the workspace/chat stores — so it silently dropped
 * the rows and leaked everything else.
 */
export function tabsForServer(serverId: string): string[] {
  return list.filter((t) => t.serverId === serverId).map((t) => t.sessionId);
}
