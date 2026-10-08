// Pure helpers for synchronous multi-server input ("broadcast", Phase 22).
// DOM/network-free so they're unit-tested without the store or terminals. The
// actual fan-out is just N calls to the existing `write_to_terminal` command
// from the page; here we only decide WHO receives, WHAT gets sent, and HOW the
// member terminals are laid out. (ADR 0003: pure logic in `.ts`.)

import { isProdServer, type ProdMarked } from "./aiexec";

/** The slice of a terminal tab this module needs (structural — matches `Tab`). */
export interface BroadcastTab {
  sessionId: string;
  kind: "ssh" | "local";
  serverId: string;
  /** Canonical English status label (see tabs store `statusLabel`). */
  status: string;
}

/** A live session is one that's connected or still connecting. */
const isLiveStatus = (s: string): boolean =>
  s.startsWith("Connected") || s.startsWith("Connecting");

/**
 * The members that should actually receive input, ordered by tab order (stable
 * layout). Drops ids that are no longer open or whose session isn't live, so a
 * closed/errored member is silently skipped rather than written to.
 */
export function eligibleMembers(
  memberIds: Iterable<string>,
  tabs: BroadcastTab[],
): string[] {
  const set = new Set(memberIds);
  return tabs
    .filter((tab) => set.has(tab.sessionId) && isLiveStatus(tab.status))
    .map((tab) => tab.sessionId);
}

/** Minimal server shape for the prod check (id + prod flag / legacy tags). */
export interface ProdTaggable extends ProdMarked {
  id: string;
}

/**
 * Session ids among `targets` whose SSH server carries a prod tag. Local tabs
 * and unknown servers are never prod. Drives the pre-send confirmation.
 */
export function prodMembers(
  targets: string[],
  tabs: BroadcastTab[],
  servers: ProdTaggable[],
): string[] {
  const byId = new Map(tabs.map((tab) => [tab.sessionId, tab]));
  return targets.filter((id) => {
    const tab = byId.get(id);
    if (!tab || tab.kind !== "ssh") return false;
    return isProdServer(servers.find((s) => s.id === tab.serverId));
  });
}

/** Whether any target is a prod server (→ require confirmation before send). */
export function groupHasProd(
  targets: string[],
  tabs: BroadcastTab[],
  servers: ProdTaggable[],
): boolean {
  return prodMembers(targets, tabs, servers).length > 0;
}

/**
 * The exact bytes-as-string to send to every target: the command plus the Enter
 * byte so it executes. Returns null for an empty command (nothing to send). We do
 * not trim — leading/trailing spaces are the user's to decide.
 */
import { submitLine } from "./terminput";

export function frameCommand(cmd: string): string | null {
  if (cmd.length === 0) return null;
  return submitLine(cmd);
}

/** Narrowest a pane of the grid is asked to be (≈48 terminal columns). */
export const MIN_TILE = 380;
/** Never more than this many columns, even on very wide windows. */
export const MAX_COLS = 4;

/**
 * How many columns the grid of members asks for: as many as fit at `minTile`
 * width, but never more than the member count or `maxCols`. Whether that many
 * panes fit at all is the layout's question (`gridFit` in splitlayout.ts).
 */
export function gridColumns(
  containerWidth: number,
  n: number,
  minTile = MIN_TILE,
  maxCols = MAX_COLS,
): number {
  if (n <= 1) return 1;
  const fit = Math.max(1, Math.floor(containerWidth / minTile));
  return Math.max(1, Math.min(n, fit, maxCols));
}
