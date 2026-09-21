// Questions raised about something on screen, and when the assistant may take a
// new turn — pure logic, shared by the chat composer, the "ask about this" entry
// points and the store's startChat.
//
// An entry point (terminal selection, a container, a pod, a metrics snapshot) no
// longer sends: it attaches its text to the composer as a chip, and the user asks
// their own question about it — or presses Enter for the preset one. Consent runs
// on send, like any other context.
//
// A chat runs one turn at a time: a second stream started over a live one
// overwrote its listener handle (so Stop no longer reached it) and the first
// `done` cleared `streaming` while the other was still writing. The dialog loop
// is busy between replies too — a command is executing and its result is about
// to be fed back — so a user turn slipped in there would interleave with it.
//
// DOM/network-free → unit-tested directly.

import type { MessageKey } from "./i18n/messages";

/** What a raised question is about. */
export type AskSource = "selection" | "container" | "pod" | "metrics";

export interface AskPreset {
  /** Canonical English `###` header of the context block — data for the model,
   *  so it is not localized. */
  header: string;
  /** The chip's label in the composer. */
  label: MessageKey;
  /** The question sent when the user attaches no words of their own. */
  question: MessageKey;
}

export const ASK_PRESETS: Record<AskSource, AskPreset> = {
  selection: { header: "Terminal selection", label: "ai.attach.selection", question: "ai.ask.explainSelection" },
  container: { header: "Docker container", label: "ai.attach.container", question: "ai.ask.container" },
  pod: { header: "Kubernetes pod", label: "ai.attach.pod", question: "ai.ask.pod" },
  metrics: { header: "Host metrics", label: "ai.attach.metrics", question: "ai.ask.metrics" },
};

/** The slice of a session chat that decides whether it is mid-turn. */
export interface ChatActivity {
  /** A reply is streaming in. */
  streaming: boolean;
  /** A dialog command is waiting for the user's go-ahead. */
  pending: unknown;
  /** The dialog loop is running (executing a step or about to feed it back). */
  dialogRunning: boolean;
}

/** The chat is in the middle of a turn and must not start another. */
export function chatBusy(c: ChatActivity): boolean {
  return c.streaming || c.pending != null || c.dialogRunning;
}

/** Why a raised question can't even be attached. A busy chat is not a reason:
 *  the chip waits in the composer, and the send is what waits for the turn. */
export type AskBlock = "notReady" | "noAi";

export function askBlocker(s: { ready: boolean; noAi: boolean }): AskBlock | null {
  if (!s.ready) return "notReady";
  if (s.noAi) return "noAi";
  return null;
}

/** i18n key of the toast explaining an {@link AskBlock}. */
export const ASK_BLOCK_MESSAGE: Record<AskBlock, MessageKey> = {
  notReady: "ai.disabledHint",
  noAi: "ai.noAiBanner",
};
