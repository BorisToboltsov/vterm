// Pure helpers for synchronous multi-server input ("broadcast", Phase 22).
// DOM/network-free so they're unit-tested without the store or terminals. The
// actual fan-out is just N calls to the existing `write_to_terminal` command
// from the page; here we only decide WHO receives, WHAT gets sent, and HOW the
// member terminals are laid out. (ADR 0003: pure logic in `.ts`.)

import { isProdServer } from "./aiexec";

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

/** Minimal server shape for the prod check (id + tags). */
export interface ProdTaggable {
  id: string;
  tags?: string[];
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
    return isProdServer(servers.find((s) => s.id === tab.serverId)?.tags);
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

export type BroadcastLayout = "grid" | "focus";

/** Above this many members the tiled grid gives way to focus + roster. */
export const FOCUS_THRESHOLD = 9;

/**
 * Default layout for `n` members: a readable tiled grid up to the threshold,
 * then a single focused terminal + a compact roster of the rest (so 10, 30 or
 * 50 members all stay usable instead of shrinking into unreadable tiles).
 */
export function pickLayout(n: number, threshold = FOCUS_THRESHOLD): BroadcastLayout {
  return n > threshold ? "focus" : "grid";
}

/** Minimum readable tile width (≈48 cols) before the grid scrolls instead. */
export const MIN_TILE = 380;
/** Never more than this many columns, even on very wide windows. */
export const MAX_COLS = 4;

/**
 * How many columns the tiled grid uses: as many as fit at `minTile` width, but
 * never more than the member count or `maxCols`. Rows beyond what fits scroll.
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
