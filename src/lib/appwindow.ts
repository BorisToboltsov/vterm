// Which of the app's windows this is (ADR 0017).
//
// A tab can be moved out into a window of its own; that window loads the same
// page, with its own tabs, panes and docks. What differs is decided by the
// window's label and nothing else: `main` is the window the app starts with —
// closing it quits, it takes "Open with vterm" and it alone saves the dock
// layout — and `win-N` is a window a tab was moved to.

import { getCurrentWindow } from "@tauri-apps/api/window";

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
