// Files dragged out of the app (v1.14, ADR 0027) — the pure half: whether the
// system can be handed these files, and what it is handed.
//
// A page draws nothing outside its window and its drop reaches no other
// program. So when files of a server leave the window, the drag is handed to
// the system, which carries a *promise* of them (`src-tauri/src/dragout.rs`).
// What cannot be promised is not handed over at all — the page's own drag goes
// on, exactly as before 1.14 — and this module says which is which.

import type { CarriedFiles, DropTab } from "./filedrop";

/** Where the system can carry a promised file (mirror of `SUPPORTED` in dragout.rs). */
export function dragOutOffered(os: string): boolean {
  return os === "macos" || os === "windows";
}

/**
 * Why files cannot be handed to the system:
 *  - `unsupported` — this system has no way to carry a promise (Linux);
 *  - `here` — they are on this machine already: a local tab's panel, the desktop;
 *  - `offline` — their session is not up, there is nothing to read them from;
 *  - `folders` — a folder among them, where only files can be promised
 *    (Explorer is told every file before the drop; mirror of `FOLDERS` in
 *    dragout.rs).
 */
export type DragOutBlocker = "unsupported" | "here" | "offline" | "folders";

/** Why `files` cannot be handed to the system; null — they can. */
export function dragOutBlocker(
  files: CarriedFiles,
  tabs: readonly DropTab[],
  os: string,
): DragOutBlocker | null {
  if (!dragOutOffered(os)) return "unsupported";
  if (files.from === null || files.local) return "here";
  const tab = tabs.find((t) => t.sessionId === files.from);
  if (!tab || tab.kind !== "ssh" || !tab.connected) return "offline";
  if (os === "windows" && files.entries.some((e) => e.isDir)) return "folders";
  return null;
}

/**
 * A blocker the user is told of — when the files are let go of outside every
 * window, where a drop was plainly meant. The others need no telling: a system
 * that cannot do it never could, and files of this machine are the file
 * manager's own to drag.
 */
export function dragOutTold(blocker: DragOutBlocker | null): blocker is "folders" | "offline" {
  return blocker === "folders" || blocker === "offline";
}

/** One file or folder promised to the system. */
export interface DragOutItem {
  path: string;
  name: string;
  isDir: boolean;
}

/** What the backend is handed (`drag_out_begin`). */
export interface DragOutSpec {
  /** The session whose server the files are on. */
  session: string;
  /** What its tab is called. */
  label: string;
  items: DragOutItem[];
  /**
   * The files as a window of the app is told of them: while the system has
   * the drag, the backend passes this on to the window under the pointer.
   */
  carried: Record<string, unknown>;
}

/** What is handed over for `files`; null — they have no session to read from. */
export function dragOutSpec(
  files: CarriedFiles,
  carried: Record<string, unknown>,
): DragOutSpec | null {
  if (files.from === null || files.entries.length === 0) return null;
  return {
    session: files.from,
    label: files.label,
    items: files.entries.map(({ path, name, isDir }) => ({ path, name, isDir })),
    carried,
  };
}
