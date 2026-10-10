// "Copy to another session" (v1.12) — what the file panels and the page tell
// each other. A file panel is mounted deep inside a dock and knows nothing of
// the window's tabs; the page knows the tabs and owns the dialog. Rather than
// thread both through four layers of props, they meet here:
//
//  - the page publishes the tabs a file can be copied to (`setCopyTargets`);
//  - a panel offers them in its row menu and files a request (`requestCopy`);
//  - a panel on screen says what is selected in it (`setFileSelection`), so the
//    command palette can offer the same copy without the mouse.
//
// Nothing here survives a tab: a selection is the panel's, republished whenever
// the panel is on screen, and dropped in the tab's teardown.

import type { CopyTarget } from "../copyto";
import type { FileEntry } from "../types";

/** A panel's selection: what a copy started from the palette would take. */
export interface FileSelection {
  /** The panel shows this machine's files (a local tab), not a server's. */
  local: boolean;
  entries: FileEntry[];
}

/** One thing to copy: enough to start the transfer and to name it. */
export type CopyEntry = Pick<FileEntry, "path" | "name" | "isDir">;

/** "Copy these, from that tab's panel, to this tab." */
export interface CopyRequest {
  /** The tab they come from; null — from the desktop (files dropped on the window). */
  from: string | null;
  local: boolean;
  /**
   * What the source tab is called, when it is not a tab of this window (files
   * held over this window from another one say so themselves).
   */
  label?: string;
  to: string;
  entries: CopyEntry[];
}

/** "Move these rows of that panel into this folder of it" (a drop inside one panel, v1.13). */
export interface MoveRequest {
  /** The panel the rows belong to — its session, or its own key when it has none. */
  session: string;
  paths: string[];
  dir: string;
}

const state = $state<{
  targets: CopyTarget[];
  request: CopyRequest | null;
  move: MoveRequest | null;
  selection: Record<string, FileSelection>;
}>({ targets: [], request: null, move: null, selection: {} });

/** The tabs a file can be copied to (the page keeps this current). */
export function setCopyTargets(targets: CopyTarget[]): void {
  state.targets = targets;
}

export const copyTargetList = (): CopyTarget[] => state.targets;

/** File a request; the page opens the dialog for it. */
export function requestCopy(request: CopyRequest): void {
  if (request.entries.length > 0) state.request = request;
}

/** The request waiting to be shown, if any (reactive). */
export const pendingCopyRequest = (): CopyRequest | null => state.request;

/** Take the waiting request off — the page is showing it now. */
export function takeCopyRequest(): CopyRequest | null {
  const request = state.request;
  state.request = null;
  return request;
}

/**
 * Rows were let go of over a folder of their own panel. The panel that shows
 * that session now picks the request up and asks its question — it need not be
 * the instance the drag began in.
 */
export function requestMove(request: MoveRequest): void {
  if (request.paths.length > 0) state.move = request;
}

export const pendingMoveRequest = (): MoveRequest | null => state.move;

export function takeMoveRequest(): MoveRequest | null {
  const request = state.move;
  state.move = null;
  return request;
}

/** What is selected in the panel of `sessionId`, or null to forget it. */
export function setFileSelection(sessionId: string, selection: FileSelection | null): void {
  if (selection && selection.entries.length > 0) state.selection[sessionId] = selection;
  else delete state.selection[sessionId];
}

export function fileSelectionOf(sessionId: string): FileSelection | null {
  return state.selection[sessionId] ?? null;
}

/** Forget everything (tests).  */
export function resetFileCopy(): void {
  state.targets = [];
  state.request = null;
  state.move = null;
  for (const id of Object.keys(state.selection)) delete state.selection[id];
}
