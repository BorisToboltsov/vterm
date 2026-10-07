// A tab of ANOTHER window held over this one (v1.4, ADR 0018).
//
// The window a tab is dragged out of keeps the pointer — its events never reach
// this one — so the backend relays where the tab is: `over` while it is held
// here, `drop` when it is let go of here (the tab itself then follows as a
// handoff), `leave` when it goes elsewhere or the drop comes to nothing.
//
// This window then does for it what it does for a tab of its own in the air
// (`tabdrag.svelte.ts`): draws its label under the pointer, parts the tabs of
// the strip it is over and tints the half of a pane it would take.
//
// **The layout does not change until the tab arrives.** What is shown is a
// preview (`previewIncoming`): a placeholder in a strip, a tint over a pane. A
// preview that moved panes for real would resize terminals — a `SIGWINCH` per
// pixel for programs that have nothing to do with the drag — and would have to
// be undone if the tab went elsewhere.

import type { Rect, TabDrop } from "../splitlayout";
import type { AttachTarget } from "../tabattach";
import { tabDropAt } from "./tabdrag.svelte";
import type { Tab } from "./tabs.svelte";

/** The id the newcomer's place has in a strip until it arrives; no session has it. */
export const INCOMING_TAB = "@incoming";

/**
 * What a tab's label and its place in a strip are drawn from, and nothing else
 * of it: not its secret, not the argv that enters its container.
 */
export type IncomingTab = Pick<Tab, "kind" | "serverId" | "alias" | "status"> & {
  attach?: AttachTarget;
};

/** What this window is told about a tab dragged from another one (mirror of `appwin::DragEvent`). */
export type DragMessage =
  | { kind: "over" | "drop"; x: number; y: number; tab: IncomingTab }
  | { kind: "leave" };

/** How long a place is kept for a tab that was let go of here but has not arrived. */
export const LANDING_TIMEOUT_MS = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The part of a tab that goes to the window drawing it. */
export function describeTab(tab: Tab): IncomingTab {
  const { kind, serverId, alias, status, attach } = tab;
  const out: IncomingTab = { kind, serverId, alias, status };
  if (attach) {
    out.attach = {
      kind: attach.kind,
      name: attach.name,
      ...(attach.image === undefined ? {} : { image: attach.image }),
      ...(attach.container === undefined ? {} : { container: attach.container }),
    };
  }
  return out;
}

function parseTab(raw: unknown): IncomingTab | null {
  if (!isRecord(raw)) return null;
  const { kind, serverId, alias, status, attach } = raw;
  if (kind !== "ssh" && kind !== "local") return null;
  if (typeof serverId !== "string" || typeof alias !== "string" || typeof status !== "string") {
    return null;
  }
  const tab: IncomingTab = { kind, serverId, alias, status };
  // A container tab's mark is drawn from its attachment; one that does not read
  // as such is left out — the label is then the host's, not a broken row.
  if (
    isRecord(attach) &&
    (attach.kind === "container" || attach.kind === "pod") &&
    typeof attach.name === "string"
  ) {
    tab.attach = {
      kind: attach.kind,
      name: attach.name,
      ...(typeof attach.image === "string" ? { image: attach.image } : {}),
      ...(typeof attach.container === "string" ? { container: attach.container } : {}),
    };
  }
  return tab;
}

/**
 * Read what the backend relayed. It passes on another window's word, so this is
 * read, not trusted: anything that is not one of the three messages is dropped —
 * a half-read message would draw a label with no name at a point that is not one.
 */
export function parseDragMessage(raw: unknown): DragMessage | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "leave") return { kind: "leave" };
  if (raw.kind !== "over" && raw.kind !== "drop") return null;
  const { x, y } = raw;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const tab = parseTab(raw.tab);
  return tab ? { kind: raw.kind, x, y, tab } : null;
}

export const incoming = $state<{
  /** The tab held over this window; null while none is. */
  tab: IncomingTab | null;
  /** The pointer, in viewport px — the label hangs from it. */
  x: number;
  y: number;
  /** Where the tab would land; null — where a new tab goes (the pane in focus). */
  over: TabDrop | null;
  /** The part of a pane a drop on its body would give the tab, viewport px. */
  zone: Rect | null;
  /** It was let go of here: its place is kept until the tab itself arrives. */
  landing: boolean;
}>({ tab: null, x: 0, y: 0, over: null, zone: null, landing: false });

let landingTimer: ReturnType<typeof setTimeout> | undefined;

/** Forget the tab: it left, arrived, or never came. */
export function clearIncoming(): void {
  clearTimeout(landingTimer);
  landingTimer = undefined;
  incoming.tab = null;
  incoming.over = null;
  incoming.zone = null;
  incoming.landing = false;
}

/** Take in what the backend relayed about a tab dragged from another window. */
export function applyDragMessage(msg: DragMessage): void {
  if (msg.kind === "leave") return clearIncoming();
  // Let go of here already: what is still on its way from the drag changes
  // nothing — the place it was dropped at is the place it gets.
  if (incoming.landing) return;
  incoming.tab = msg.tab;
  incoming.x = msg.x;
  incoming.y = msg.y;
  const hit = tabDropAt(msg.x, msg.y, INCOMING_TAB);
  incoming.over = hit?.drop ?? null;
  incoming.zone = hit?.zone ?? null;
  if (msg.kind === "drop") {
    incoming.landing = true;
    // The tab follows as a handoff; if it never does, the place is given up.
    landingTimer = setTimeout(clearIncoming, LANDING_TIMEOUT_MS);
  }
}

/**
 * The tab arrived: where it was dropped (null — it was not dropped here, it was
 * sent by a command, and goes where a new tab goes). The preview ends with this.
 */
export function takeIncomingDrop(): TabDrop | null {
  const drop = incoming.landing ? incoming.over : null;
  if (incoming.landing) clearIncoming();
  return drop;
}

/** The held tab as a strip draws it: a tab like any other, under the placeholder's id. */
export function incomingAsTab(): Tab | null {
  const tab = incoming.tab;
  if (!tab) return null;
  const { attach, ...rest } = tab;
  return {
    ...rest,
    sessionId: INCOMING_TAB,
    secret: null,
    remember: false,
    gen: 0,
    // Never run: the placeholder is a picture of a tab, not one.
    ...(attach ? { attach: { ...attach, argv: [] } } : {}),
  };
}
