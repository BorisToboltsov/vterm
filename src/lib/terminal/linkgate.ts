// Which click on a link in terminal output opens it (v1.36). Every kind of link
// the terminal shows — an address found in the text, an OSC 8 hyperlink, a file
// or folder a listing confirms — passes the same gate, so one gesture means one
// thing everywhere.
//
// A terminal is clicked all day long: to focus it, to place a selection, out of
// habit. A plain click that opens a file or asks about a link turns that habit
// into a dialog to dismiss. So by default only ⌘-click (macOS) or Ctrl-click
// (Windows, Linux) opens, as in PyCharm, VS Code and iTerm2; a plain click shows
// a one-line hint saying so, with the same action behind it. The old way — a
// plain click opens — stays one setting away.
//
// Pure apart from the timer: the gesture, the gate that waits out a double-click
// and the migration of the settings that came before it. The hint itself is the
// store's (`stores/linkhint.svelte.ts`), the question after it `linkopen` /
// `filelinkflow`.

import { isTerminalLinkMode, type TerminalLinkMode } from "./termlink";
import { isFileLinkMode, type FileLinkMode } from "./termfiles";

/** `settings.terminalLinkClick`: only ⌘/Ctrl-click opens, or a plain click too. */
export const LINK_CLICKS = ["modifier", "click"] as const;
export type LinkClick = (typeof LINK_CLICKS)[number];
export const DEFAULT_LINK_CLICK: LinkClick = "modifier";

export const isLinkClick = (v: unknown): v is LinkClick =>
  typeof v === "string" && (LINK_CLICKS as readonly string[]).includes(v);

/** The keys of a click that decide what it does. */
export interface ClickKeys {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * What a click on a link does: `open` at once, open `later` (once it is clear
 * the click is not the first of a double-click), show the `hint`, or `none`.
 */
export type LinkGesture = "open" | "later" | "hint" | "none";

/**
 * The gesture of a click. Alt-click is xterm's "move the cursor here" and
 * Shift-click extends the selection: neither is about the link. On macOS
 * Ctrl-click is the secondary click, not the modifier. Nobody double-clicks
 * with ⌘ held, so a ⌘/Ctrl-click opens without waiting.
 */
export function linkGesture(click: LinkClick, keys: ClickKeys, mac: boolean): LinkGesture {
  if (keys.altKey || keys.shiftKey) return "none";
  if (mac ? keys.metaKey : keys.ctrlKey) return "open";
  if (mac && keys.ctrlKey) return "none";
  return click === "click" ? "later" : "hint";
}

/**
 * How long a plain click waits before it opens or shows the hint: long enough
 * for the second click of a double-click, which selects the name instead (the
 * user wants to copy it).
 */
export const DOUBLE_CLICK_MS = 400;

/** What the hint offers to open — it names where the link opens. */
export type LinkHintKind = "web" | "file" | "dir" | "path";

/** A point on the page, where the click landed. */
export interface PagePoint {
  x: number;
  y: number;
}

/** What the gate needs from the terminal and the page, each read when needed. */
export interface LinkGateHost {
  click(): LinkClick;
  mac(): boolean;
  /** The terminal holds a selection: a click that made it is not about a link. */
  selected(): boolean;
  /** Show the hint at the click, with `act` behind its button. */
  hint(at: PagePoint, kind: LinkHintKind, act: () => void): void;
}

export interface LinkGate {
  /** A click on a link: `act` is what opening it means. */
  activate(event: MouseEvent, kind: LinkHintKind, act: () => void): void;
  dispose(): void;
}

/** One terminal's gate: at most one click waits at a time. */
export function createLinkGate(host: LinkGateHost): LinkGate {
  let pending: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(pending);
    pending = undefined;
  };
  return {
    activate(event, kind, act) {
      cancel();
      if (host.selected()) return;
      const gesture = linkGesture(host.click(), event, host.mac());
      if (gesture === "none") return;
      // The second click of a double-click: it selects the name.
      if (event.detail > 1) return;
      if (gesture === "open") {
        act();
        return;
      }
      const at = { x: event.clientX, y: event.clientY };
      pending = setTimeout(() => {
        pending = undefined;
        if (host.selected()) return;
        if (gesture === "later") act();
        else host.hint(at, kind, act);
      }, DOUBLE_CLICK_MS);
    },
    dispose: cancel,
  };
}

/** A width and a height, in page pixels. */
export interface BoxSize {
  w: number;
  h: number;
}

/** How far below (or above) the click the hint stands, and its margin to the window's edge. */
const HINT_GAP = 14;
const HINT_MARGIN = 8;

/**
 * Where the hint's top-left corner stands: just under the click and a little
 * to its left, so the button sits under the pointer; inside the window, above
 * the click when the window ends below it.
 */
export function hintPlace(at: PagePoint, size: BoxSize, view: BoxSize): PagePoint {
  const x = Math.max(HINT_MARGIN, Math.min(at.x - 10, view.w - size.w - HINT_MARGIN));
  const below = at.y + HINT_GAP;
  const y = below + size.h + HINT_MARGIN <= view.h ? below : Math.max(HINT_MARGIN, at.y - HINT_GAP - size.h);
  return { x, y };
}

/** How far the pointer may wander from the click before the hint goes. */
export const HINT_LEAVE_PX = 120;

/** The pointer has gone far from the click: the hint is no longer about where it is. */
export function pointerLeft(at: PagePoint, pointer: PagePoint): boolean {
  return Math.hypot(pointer.x - at.x, pointer.y - at.y) > HINT_LEAVE_PX;
}

/** The link settings as they are kept. */
export interface LinkSettings {
  terminalLinks: TerminalLinkMode;
  terminalFileLinks: FileLinkMode;
  terminalLinkClick: LinkClick;
}

/**
 * The link settings out of stored ones. Settings saved before the gate have no
 * `terminalLinkClick`; their "ask first" was the default of the time, not a
 * choice — and with only a deliberate ⌘-click opening, the question is no longer
 * the guard it was — so it becomes "open right away". "Off" and "open right
 * away" stay. Once the gate's setting is saved, every mode is taken as chosen.
 */
export function migrateLinkSettings(raw: Record<string, unknown>, defaults: LinkSettings): LinkSettings {
  const before = !("terminalLinkClick" in raw);
  const web = isTerminalLinkMode(raw.terminalLinks) ? raw.terminalLinks : defaults.terminalLinks;
  const files = isFileLinkMode(raw.terminalFileLinks) ? raw.terminalFileLinks : defaults.terminalFileLinks;
  return {
    terminalLinks: before && web === "confirm" ? "direct" : web,
    terminalFileLinks: before && files === "confirm" ? "direct" : files,
    terminalLinkClick: isLinkClick(raw.terminalLinkClick) ? raw.terminalLinkClick : defaults.terminalLinkClick,
  };
}
