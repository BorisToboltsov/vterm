// Files dragged out of the app (v1.14, ADR 0027) — the pure half: whether the
// system can be handed these files, and what it is handed.
//
// A page draws nothing outside its window and its drop reaches no other
// program. So when files of a server leave the window, the drag is handed to
// the system, which carries a *promise* of them (`src-tauri/src/dragout.rs`).
// Files of a local tab's panel are handed over too since v1.36 (ADR 0059) — as
// they are, from where they are. What cannot be handed over is not handed over
// at all — the page's own drag goes on, exactly as before 1.14 — and this
// module says which is which.

import type { MessageKey } from "../i18n";
import { describeFiles, type CarriedFiles, type DropTab } from "./filedrop";

/** Where the system can carry a promised file (mirror of `SUPPORTED` in dragout.rs). */
export function dragOutOffered(os: string): boolean {
  return os === "macos" || os === "windows";
}

/**
 * Why files cannot be handed to the system:
 *  - `unsupported` — this system has no way to carry them (Linux);
 *  - `here` — they are the desktop's own, passing over the window;
 *  - `offline` — their session is not up, there is nothing to read them from.
 *
 * A folder is no reason (v1.36): Explorer is told what is in it — the backend
 * walks it when the drag begins, and says why not when it cannot
 * (`dragOutDeclined`). Files of a local tab's panel are no reason either: they
 * go as they are, with no session to read them from.
 */
export type DragOutBlocker = "unsupported" | "here" | "offline";

/** Why `files` cannot be handed to the system; null — they can. */
export function dragOutBlocker(
  files: CarriedFiles,
  tabs: readonly DropTab[],
  os: string,
): DragOutBlocker | null {
  if (!dragOutOffered(os)) return "unsupported";
  if (files.from === null) return "here";
  if (files.local) return null;
  const tab = tabs.find((t) => t.sessionId === files.from);
  if (!tab || tab.kind !== "ssh" || !tab.connected) return "offline";
  return null;
}

/**
 * A blocker the user is told of — when the files are let go of outside every
 * window, where a drop was plainly meant. The others need no telling: a system
 * that cannot do it never could, and the desktop's files are its own.
 */
export function dragOutTold(blocker: DragOutBlocker | null): blocker is "offline" {
  return blocker === "offline";
}

/** Why the backend did not hand the drag to the system (mirror of `dragout::Declined`). */
export type DragOutDeclined = "name" | "tooMany" | "folderLink" | "unreadable" | "longPath" | "gone" | "notTaken";

/** What the backend answers (`drag_out_begin`). */
export interface DragOutAnswer {
  taken: boolean;
  why: DragOutDeclined | null;
}

/** The i18n key of what the user is told when the system did not take the files, and why. */
export function declinedMessage(why: DragOutDeclined | null): MessageKey {
  switch (why) {
    case "tooMany":
      return "dragout.whyTooMany";
    case "folderLink":
      return "dragout.whyFolderLink";
    case "unreadable":
      return "dragout.whyUnreadable";
    case "longPath":
      return "dragout.whyLongPath";
    case "name":
      return "dragout.whyName";
    case "gone":
      return "dragout.whyGone";
    default:
      return "dragout.declined";
  }
}

/** One file or folder promised to the system. */
export interface DragOutItem {
  path: string;
  name: string;
  isDir: boolean;
}

/** What the backend is handed (`drag_out_begin`). */
export interface DragOutSpec {
  /** The session whose server the files are on — or, for `local`, whose panel shows them. */
  session: string;
  /** The files are this machine's (a local tab's panel): `path` is where they are here. */
  local: boolean;
  /** What its tab is called. */
  label: string;
  items: DragOutItem[];
  /**
   * The files as a window of the app is told of them: while the system has
   * the drag, the backend passes this on to the window under the pointer.
   * Marked as the system's — it draws them, and a window draws no label.
   */
  carried: Record<string, unknown>;
}

/** What is handed over for `files`; null — they have no session to read from. */
export function dragOutSpec(files: CarriedFiles): DragOutSpec | null {
  if (files.from === null || files.entries.length === 0) return null;
  return {
    session: files.from,
    local: files.local,
    label: files.label,
    items: files.entries.map(({ path, name, isDir }) => ({ path, name, isDir })),
    carried: describeFiles({ ...files, system: true }),
  };
}
