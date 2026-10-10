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

/** "Copy these, from that tab's panel, to this tab." */
export interface CopyRequest {
  from: string;
  local: boolean;
  to: string;
  entries: FileEntry[];
}

const state = $state<{
  targets: CopyTarget[];
  request: CopyRequest | null;
  selection: Record<string, FileSelection>;
}>({ targets: [], request: null, selection: {} });

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
  for (const id of Object.keys(state.selection)) delete state.selection[id];
}
