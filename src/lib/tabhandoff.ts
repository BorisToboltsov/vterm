// Moving a tab out into a window of its own (ADR 0017): what travels, when a
// tab may go, and what to say when it may not.
//
// A window is a separate WebView with its own memory, so a tab that moves takes
// its state along as a **packet**: the tab itself, a snapshot of its terminal,
// its open editors, its AI conversation, what its dock panels remember, and the
// few per-session facts the page keeps. The packet goes through the backend
// (IPC, in memory, handed out once) — never through `localStorage`: it carries
// the tab's typed password and the editors' sudo passwords.
//
// Pure: building the packet out of the stores and applying it is the page's
// job; the rules are here, tested without a window.

import type { MessageKey } from "./i18n";
import type { CdShell } from "./cdterminal";
import type { DockSessionState } from "./stores/dockstate.svelte";
import type { SyncJob } from "./stores/syncjob.svelte";
import type { Tab } from "./stores/tabs.svelte";
import type { Workspace } from "./stores/workspaces.svelte";
import type { SessionChat } from "./stores/aichat.svelte";

/** Bumped when the packet's shape changes. Both windows run the same build, so
 *  a mismatch is not a migration case — the packet is refused. */
export const PACKET_VERSION = 1;

/** A terminal's screen, scrollback and modes, as `@xterm/addon-serialize` writes them. */
export interface TermSnapshot {
  /** The grid the snapshot was taken at; it is replayed at the same size, then refitted. */
  cols: number;
  rows: number;
  /** Escape-sequence stream that redraws the buffer when written to a fresh xterm. */
  data: string;
  /** Commands typed in this session, newest first (the Ctrl+R list). */
  commands: string[];
}

/** Per-session facts the page itself keeps (not in a store). */
export interface PageSessionState {
  /** The shell's last reported cwd, and whether the file panel follows it. */
  terminalCwd: string | null;
  followTerminal: boolean;
  /** The cwd the follow logic last acted on — so arriving does not re-apply it. */
  followSeen: string | null;
  /** Local tabs: the `cd` dialect of the shell that was spawned. */
  localShell: CdShell | null;
  /** The shell-integration snippet was already typed into this session. */
  shellIntegrated: boolean;
  /** File of the recording in progress, and whether it is paused. */
  recording: string | null;
  recordingPaused: boolean;
}

export interface TabPacket {
  v: typeof PACKET_VERSION;
  tab: Tab;
  terminal: TermSnapshot;
  workspace: Workspace | null;
  chat: SessionChat | null;
  dock: DockSessionState | null;
  sync: SyncJob | null;
  page: PageSessionState;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const positiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Read a packet a new window was handed. It was written by this same build a
 * moment ago, so this is not a sanitizer for hostile input — it refuses what the
 * window could not work with at all (wrong version, no tab, no terminal), so a
 * broken handoff closes the window instead of showing a half-restored tab.
 */
export function parsePacket(raw: string | null): TabPacket | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== PACKET_VERSION) return null;
  const { tab, terminal, page } = value;
  if (!isRecord(tab) || typeof tab.sessionId !== "string" || !tab.sessionId) return null;
  if (tab.kind !== "ssh" && tab.kind !== "local") return null;
  if (!isRecord(terminal) || typeof terminal.data !== "string") return null;
  if (!positiveInt(terminal.cols) || !positiveInt(terminal.rows)) return null;
  if (!Array.isArray(terminal.commands)) return null;
  if (!isRecord(page)) return null;
  return value as unknown as TabPacket;
}

/** Why a tab cannot be moved out right now. */
export type DetachBlock =
  | "broadcast"
  | "lastTab"
  | "notConnected"
  | "sync"
  | "transfers"
  | "ai"
  | "editor";

/** What decides whether a tab can be moved out. */
export interface DetachState {
  /** This is the main window. */
  mainWindow: boolean;
  /** Tabs open in this window. */
  tabs: number;
  /** Broadcast (synchronous input) mode is on — it lays its members out itself. */
  broadcast: boolean;
  /** The tab's session is connected. */
  connected: boolean;
  /** Its sync job is comparing or applying. */
  syncBusy: boolean;
  /** Its transfers still in flight. */
  transfers: number;
  /** Its assistant is streaming, running a dialog step or awaiting a go-ahead. */
  chatBusy: boolean;
  /** One of its editors is loading or being saved. */
  editorBusy: boolean;
}

/**
 * The first reason a tab cannot go, or `null` when it can.
 *
 * A tab moves whole or not at all. Work that is *waiting* in this window's
 * memory — a compare, a sync run, an upload, a streaming answer, a save — cannot
 * be carried to another window: its continuation would be left behind, with
 * nothing to hand its result to. So the tab waits for it instead.
 *
 * Structural reasons come first (they are not something to wait out), then the
 * session, then work in flight.
 */
export function detachBlocker(s: DetachState): DetachBlock | null {
  if (s.broadcast) return "broadcast";
  // A secondary window exists for its tabs: moving its only one out would close
  // it and open the same window again.
  if (!s.mainWindow && s.tabs <= 1) return "lastTab";
  if (!s.connected) return "notConnected";
  if (s.syncBusy) return "sync";
  if (s.transfers > 0) return "transfers";
  if (s.chatBusy) return "ai";
  if (s.editorBusy) return "editor";
  return null;
}

/** i18n key of the message explaining a {@link DetachBlock}. */
export const DETACH_BLOCK_MESSAGE: Record<DetachBlock, MessageKey> = {
  broadcast: "window.detachBlockedBroadcast",
  lastTab: "window.detachBlockedLastTab",
  notConnected: "window.detachBlockedNotConnected",
  sync: "window.detachBlockedSync",
  transfers: "window.detachBlockedTransfers",
  ai: "window.detachBlockedAi",
  editor: "window.detachBlockedEditor",
};

/**
 * Whether "move to a new window" is offered for a tab at all. The structural
 * blocks hide the command — there is nothing to wait for; the others leave it
 * in place and explain themselves when it is used.
 */
export function detachOffered(s: Pick<DetachState, "mainWindow" | "tabs" | "broadcast">): boolean {
  return !s.broadcast && (s.mainWindow || s.tabs > 1);
}

/**
 * i18n key for a handoff the backend rolled back. `handoff-overflow` is its own
 * case: the remedy is the user's (wait for the output to settle), unlike a
 * window that failed to start.
 */
export function detachErrorKey(error: unknown): MessageKey {
  return String(error).includes("handoff-overflow")
    ? "window.detachOverflow"
    : "window.detachFailed";
}

/** Offset of a dragged tab's label from the pointer. */
const GHOST_OFFSET = { x: 12, y: 8 };
/** Room the label needs to stay readable when it is pinned inside the window. */
const GHOST_BOX = { width: 260, height: 36, margin: 8 };

/**
 * Where to draw the label of a tab being dragged. Inside the window it hangs
 * from the pointer; once the pointer has left, the label cannot follow it (a
 * page draws nothing outside its window), so it stops at the edge the pointer
 * went out through — still in sight, saying what letting go will do.
 */
export function ghostPlace(
  drag: { x: number; y: number; outside: boolean },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const x = drag.x + GHOST_OFFSET.x;
  const y = drag.y + GHOST_OFFSET.y;
  if (!drag.outside) return { x, y };
  const clamp = (v: number, max: number) => Math.max(GHOST_BOX.margin, Math.min(v, max));
  return {
    x: clamp(x, viewport.width - GHOST_BOX.width - GHOST_BOX.margin),
    y: clamp(y, viewport.height - GHOST_BOX.height - GHOST_BOX.margin),
  };
}

/**
 * Whether a pointer released at (`x`, `y`) — viewport px — let go of a tab
 * outside the window: the gesture that moves it to a window of its own.
 */
export function releasedOutside(
  x: number,
  y: number,
  viewport: { width: number; height: number },
): boolean {
  return x < 0 || y < 0 || x >= viewport.width || y >= viewport.height;
}
