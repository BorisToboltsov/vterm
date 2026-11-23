// A click on a web link in terminal output (v1.20). Every terminal hands its
// links here — the URLs it finds in the text and OSC 8 hyperlinks alike — and
// nowhere else, once its link gate (`linkgate.ts`, v1.36) has let the click
// through: ⌘/Ctrl-click, the hint's button, or a plain click where the setting
// says so. What the click does is `linkClick` (termlink.ts), the question is
// the window's one `LinkOpenDialog`, and only this file passes a link to the
// system browser. A second click cannot land while the question is up: the
// dialog covers the terminals.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { ILinkHandler } from "@xterm/xterm";
import { linkClick, rangeText, type LinkQuestion, type TextBuffer } from "../terminal/termlink";
import { createLinkGate, type LinkGate } from "../terminal/linkgate";
import { hostEnv } from "./hostenv.svelte";
import { showLinkHint } from "./linkhint.svelte";
import { settings } from "../settings/settings.svelte";
import { writeClipboard } from "../app/clipboard";
import { notifyError, notifySuccess } from "./toasts.svelte";
import { t } from "../i18n";

let question = $state<LinkQuestion | null>(null);

/** The question on screen now, or null. */
export const currentLinkQuestion = (): LinkQuestion | null => question;

function open(href: string): void {
  openUrl(href).catch((e) => notifyError(t("link.openFailed", { error: String(e) }), { source: "terminal" }));
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
 * The link gate of one xterm the app creates (`linkgate.ts`): the click setting,
 * the OS that decides which key is the modifier, the terminal's own selection,
 * and the window's one hint. Every link of that terminal — found, OSC 8, file —
 * passes it.
 */
export function terminalLinkGate(selected: () => boolean): LinkGate {
  return createLinkGate({
    click: () => settings.terminalLinkClick,
    mac: () => hostEnv.os === "macos",
    selected,
    hint: showLinkHint,
  });
}

/**
 * The `linkHandler` of every xterm the app creates. OSC 8 hyperlinks set what
 * is shown apart from where it leads, so they get the question with the text
 * shown — never xterm's own English `confirm()` and `window.open()`. The click
 * passes the terminal's gate first, like any other link; the text is read at
 * the click, before the gate waits out a double-click.
 */
export function terminalLinkHandler(buffer: () => TextBuffer | undefined, gate: LinkGate): ILinkHandler {
  return {
    activate: (event, uri, range) => {
      const buf = buffer();
      const text = buf ? rangeText(buf, range) : "";
      gate.activate(event, "web", () => clickLink(uri, text));
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
    void writeClipboard(asked.target.href).then(() => notifySuccess(t("link.copied"), { source: "terminal" }));
  }
}
