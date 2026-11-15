// What sudo answered, read in one place for every part of the app that asks it
// (ADR 0073): the editor's save as root, the file panel working as another user,
// a tool install, a recipe. The backend reads sudo's own words (`sudo.rs`) and
// sends a marker; this reads the marker, names the answer for the window and
// decides what the next step is. The window never holds a sudo password: it
// types one into a prompt and hands it to `sudoCheck` once.

import type { MessageKey } from "../i18n";
import type { SudoRefusal, SudoRoute, SudoTried, SudoVia } from "../types";

/** What sudo answered, as the window acts on it. */
export type SudoAnswer =
  /** It wants a password vterm does not have — `tried` says which saved one it turned down. */
  | { kind: "password"; tried: SudoTried }
  /** It did not take the password typed for it. */
  | { kind: "wrong" }
  /** It will not, whatever the password. */
  | { kind: "refused"; why: SudoRefusal; said: string };

const REFUSALS: readonly SudoRefusal[] = [
  "not-allowed",
  "command-refused",
  "no-sudo",
  "needs-tty",
  "account-locked",
  "password-expired",
  "no-answer",
  "other",
];

const isRefusal = (v: string): v is SudoRefusal => (REFUSALS as readonly string[]).includes(v);
const isTried = (v: string): v is SudoTried => v === "nothing" || v === "saved" || v === "login";

/** Read the backend's sudo markers (`AppError`); anything else is not sudo's answer. */
export function sudoAnswer(e: unknown): SudoAnswer | null {
  const text = String(e);
  if (text.startsWith("sudo-password:")) {
    const tried = text.slice("sudo-password:".length).trim();
    return { kind: "password", tried: isTried(tried) ? tried : "nothing" };
  }
  if (text.startsWith("sudo-rejected:")) return { kind: "wrong" };
  if (text.startsWith("sudo-refused:")) {
    const rest = text.slice("sudo-refused:".length).trim();
    const cut = rest.indexOf(":");
    const why = cut < 0 ? "" : rest.slice(0, cut).trim();
    return isRefusal(why)
      ? { kind: "refused", why, said: rest.slice(cut + 1).trim() }
      : { kind: "refused", why: "other", said: rest };
  }
  return null;
}

/** The short name of a refusal — a badge, a title. */
export const REFUSAL_TITLE: Record<SudoRefusal, MessageKey> = {
  "not-allowed": "sudo.why.not-allowed",
  "command-refused": "sudo.why.command-refused",
  "no-sudo": "sudo.why.no-sudo",
  "needs-tty": "sudo.why.needs-tty",
  "account-locked": "sudo.why.account-locked",
  "password-expired": "sudo.why.password-expired",
  "no-answer": "sudo.why.no-answer",
  other: "sudo.why.other",
};

/** What a refusal means and what is left to do — one sentence under the title. */
export const REFUSAL_HINT: Record<SudoRefusal, MessageKey> = {
  "not-allowed": "sudo.hint.not-allowed",
  "command-refused": "sudo.hint.command-refused",
  "no-sudo": "sudo.hint.no-sudo",
  "needs-tty": "sudo.hint.needs-tty",
  "account-locked": "sudo.hint.account-locked",
  "password-expired": "sudo.hint.password-expired",
  "no-answer": "sudo.hint.no-answer",
  other: "sudo.hint.other",
};

/** Why a password is asked for when a saved one was tried first, or nothing. */
export function triedNote(tried: SudoTried): MessageKey | null {
  if (tried === "saved") return "sudo.triedSaved";
  if (tried === "login") return "sudo.triedLogin";
  return null;
}

/** Whether a refusal may pass on its own: only no answer is worth asking again. */
export const refusalRetries = (why: SudoRefusal): boolean => why === "no-answer";

/** How the editor shows what it knows of sudo next to Save. */
export interface SudoBadge {
  key: MessageKey;
  tone: "muted" | "accent" | "warn" | "danger";
  /** A click on it gets sudo going (check, confirm or ask). */
  acts: boolean;
}

/** The badge of a file the login user cannot write: what saving it will take. */
export function sudoBadge(route: SudoRoute | null): SudoBadge {
  if (!route) return { key: "sudo.badge.checking", tone: "muted", acts: false };
  switch (route.kind) {
    case "ready":
      return { key: "sudo.badge.ready", tone: "accent", acts: true };
    case "saved":
      return { key: route.from === "login" ? "sudo.badge.login" : "sudo.badge.keychain", tone: "accent", acts: true };
    case "password":
      return { key: "sudo.badge.password", tone: "warn", acts: true };
    case "refused":
      return route.why === "not-allowed"
        ? { key: "sudo.badge.notAllowed", tone: "danger", acts: false }
        : { key: REFUSAL_TITLE[route.why], tone: refusalRetries(route.why) ? "warn" : "danger", acts: refusalRetries(route.why) };
  }
}

/**
 * What getting sudo going takes, from what is known of it:
 * - `check` — try at once: sudo wants no password, or one is saved;
 * - `confirm` — the same, after one explicit question: on a production server
 *   root is never taken without the user saying so (principle 7);
 * - `ask` — a password has to be typed;
 * - `refused` — sudo will not, and asking again would change nothing.
 * Not known yet (`null`): try — the backend finds out on its own.
 */
export type ElevateStep = "check" | "confirm" | "ask" | "refused";

export function elevateStep(route: SudoRoute | null, prod: boolean): ElevateStep {
  if (route?.kind === "password") return "ask";
  if (route?.kind === "refused" && !refusalRetries(route.why)) return "refused";
  return prod ? "confirm" : "check";
}

/** Whether Save on a file the login user cannot write goes through sudo by itself. */
export const savesThroughSudo = (route: SudoRoute | null): boolean =>
  route?.kind === "ready" || route?.kind === "saved";

/** Whose password goes, said before it goes. */
export const SOURCE_TEXT: Record<SudoVia, MessageKey> = {
  none: "sudo.from.none",
  typed: "sudo.from.typed",
  saved: "sudo.from.saved",
  login: "sudo.from.login",
};

/** What a sudo field shows (`SudoField`): still finding out, whose password will
 *  go, a password to type (and why it is asked), or sudo's refusal. */
export type SudoFieldState =
  | { kind: "checking" }
  | { kind: "ready"; source: SudoVia }
  | { kind: "type"; note: MessageKey | null }
  | { kind: "refused"; why: SudoRefusal; said: string };

/** The field for what is known of sudo before a password is tried. */
export function fieldState(route: SudoRoute | null): SudoFieldState {
  if (!route) return { kind: "checking" };
  switch (route.kind) {
    case "ready":
      return { kind: "ready", source: route.via };
    case "saved":
      return { kind: "ready", source: route.from };
    case "password":
      return { kind: "type", note: triedNote(route.tried) };
    case "refused":
      return { kind: "refused", why: route.why, said: route.said };
  }
}

/** The field after sudo answered a try: ask (saying why), or its refusal. */
export function fieldAfter(answer: SudoAnswer): SudoFieldState {
  if (answer.kind === "refused") return { kind: "refused", why: answer.why, said: answer.said };
  return { kind: "type", note: answer.kind === "wrong" ? "sudo.wrongPassword" : triedNote(answer.tried) };
}
