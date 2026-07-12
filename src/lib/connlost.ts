// Pure classification of why a live session ended, to decide whether to show the
// "NO SIGNAL" disconnect screen (Phase 0.28). NO SIGNAL is reserved for an
// UNEXPECTED drop of a session that had actually connected — never a user-initiated
// disconnect (that's routine) and never a failed connect (the connecting-overlay
// already shows its own error state). Tested in connlost.test.ts.

export type CloseKind = "manual" | "dropped" | "failed";

export interface CloseInput {
  /** True when the user explicitly disconnected/closed this session. */
  userInitiated: boolean;
  /** True when the session had reached a Connected state before it ended. */
  wasConnected: boolean;
}

/** Bucket a session close: routine `manual`, a real `dropped` link, or a
 *  never-connected `failed` attempt. */
export function classifyClose(i: CloseInput): CloseKind {
  if (i.userInitiated) return "manual";
  return i.wasConnected ? "dropped" : "failed";
}

/** Only an unexpected drop of a connected session shows the NO SIGNAL screen. */
export function showNoSignal(i: CloseInput): boolean {
  return classifyClose(i) === "dropped";
}
