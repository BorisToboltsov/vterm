// A click on a web link in terminal output (v1.20). Every terminal hands its
// links here — the URLs it finds in the text and OSC 8 hyperlinks alike — and
// nowhere else: what the click does is `linkClick` (termlink.ts), the question
// is the window's one `LinkOpenDialog`, and only this file passes a link to the
// system browser. A second click cannot land while the question is up: the
// dialog covers the terminals.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { ILinkHandler } from "@xterm/xterm";
import { linkClick, rangeText, type LinkQuestion, type TextBuffer } from "../terminal/termlink";
import { settings } from "../settings/settings.svelte";
import { writeClipboard } from "../app/clipboard";
import { notifyError, notifySuccess } from "./toasts.svelte";
import { t } from "../i18n";

let question = $state<LinkQuestion | null>(null);

/** The question on screen now, or null. */
export const currentLinkQuestion = (): LinkQuestion | null => question;

function open(href: string): void {
  openUrl(href).catch((e) => notifyError(t("link.openFailed", { error: String(e) })));
}

/**
 * A link was clicked in a terminal: `uri` is where it leads, `text` what the
 * terminal shows for it — passed for an OSC 8 link only.
 */
export function clickLink(uri: string, text?: string): void {
  const action = linkClick(settings.terminalLinks, uri, text);
  if (action.kind === "open") open(action.href);
  else if (action.kind === "ask") question = action.question;
}

/**
 * The `linkHandler` of every xterm the app creates. OSC 8 hyperlinks set what
 * is shown apart from where it leads, so they get the question with the text
 * shown — never xterm's own English `confirm()` and `window.open()`.
 */
export function terminalLinkHandler(buffer: () => TextBuffer | undefined): ILinkHandler {
  return {
    activate: (_event, uri, range) => {
      const buf = buffer();
      clickLink(uri, buf ? rangeText(buf, range) : "");
    },
  };
}

export type LinkAnswer = "open" | "copy" | "cancel";

/**
 * Answer the question on screen. `silence` — "don't ask again" was ticked; it
 * counts only for the link actually opened, and only where it was offered.
 */
export function answerLink(answer: LinkAnswer, silence = false): void {
  const asked = question;
  question = null;
  if (asked === null) return;
  if (answer === "open") {
    if (!asked.target.openable) return;
    if (silence && asked.canSilence) settings.terminalLinks = "direct";
    open(asked.target.href);
  } else if (answer === "copy") {
    void writeClipboard(asked.target.href).then(() => notifySuccess(t("link.copied")));
  }
}
