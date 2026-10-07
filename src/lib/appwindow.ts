// Which of the app's windows this is, and what the others are (ADR 0017, 0018).
//
// A tab can be moved out into a window of its own; that window loads the same
// page, with its own tabs, panes and docks. What differs is decided by the
// window's label and nothing else: `main` is the window the app starts with —
// closing it quits, it takes "Open with vterm" and it alone saves the dock
// layout — and `win-N` is a window a tab was moved to.
//
// A tab can also be moved into a window that is already open. Each window
// tells the backend that it takes tabs and what it shows; the list of them all
// comes back to every window, and the rest of this file reads it.

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MessageKey, MessageParams } from "./i18n/messages";

/** Label of the window the app starts with (mirror of `appwin::MAIN`). */
export const MAIN_WINDOW = "main";

/** Whether a window label names the main window. */
export const isMainLabel = (label: string): boolean => label === MAIN_WINDOW;

/**
 * The label of the window this page runs in. Outside a Tauri window (unit tests,
 * the browser preview) there is nothing to ask — that page is the main window.
 */
export function readWindowLabel(read: () => string = () => getCurrentWindow().label): string {
  try {
    const label = read();
    return typeof label === "string" && label ? label : MAIN_WINDOW;
  } catch {
    return MAIN_WINDOW;
  }
}

/** This window's label; fixed for the life of the page. */
export const windowLabel = readWindowLabel();

/** This is the main window. */
export const isMainWindow = isMainLabel(windowLabel);

/** A window that takes tabs, as every window is told of it (mirror of `appwin::WindowEntry`). */
export interface WindowEntry {
  label: string;
  /** Title of the tab its focused pane shows; empty while it shows none. */
  title: string;
  /** Tabs open in it. */
  tabs: number;
}

function isEntry(v: unknown): v is WindowEntry {
  if (typeof v !== "object" || v === null) return false;
  const { label, title, tabs } = v as Record<string, unknown>;
  return (
    typeof label === "string" &&
    label !== "" &&
    typeof title === "string" &&
    typeof tabs === "number" &&
    Number.isInteger(tabs) &&
    tabs >= 0
  );
}

/**
 * The windows a tab of the window `self` can be moved to: every listed one but
 * itself, in the order they are listed (the main window, then the others as
 * they were opened).
 *
 * The list arrives as an event payload — read, not trusted: what is not a list
 * gives none, and what is not an entry is dropped rather than shown as a
 * nameless window nothing can be moved to.
 */
export function otherWindows(roster: unknown, self: string): WindowEntry[] {
  if (!Array.isArray(roster)) return [];
  return roster
    .filter(isEntry)
    .filter((w) => w.label !== self)
    .map(({ label, title, tabs }) => ({ label, title, tabs }));
}

/** Number of a secondary window (`win-3` → 3); null for any other label. */
export function windowNumber(label: string): number | null {
  const m = /^win-(\d+)$/.exec(label);
  return m ? Number(m[1]) : null;
}

/**
 * How a window is named as the place a tab moves to (an i18n key and its
 * params). The main window is the one of its kind. Any other is told apart by
 * the tab it shows — the only thing of it the user sees — with how many more it
 * holds; one that shows no tab right now falls back to its number.
 */
export function windowTarget(w: WindowEntry): { key: MessageKey; params?: MessageParams } {
  if (isMainLabel(w.label)) return { key: "window.toMain" };
  if (w.title) {
    return w.tabs > 1
      ? { key: "window.toNamedMore", params: { name: w.title, more: w.tabs - 1 } }
      : { key: "window.toNamed", params: { name: w.title } };
  }
  return { key: "window.toNumbered", params: { n: windowNumber(w.label) ?? w.label } };
}
