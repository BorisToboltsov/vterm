// sudo on a session (ADR 0073): what is known before any password is tried, and
// the check that takes a typed password — the one way a sudo password goes from
// the window to the backend. From then on the session remembers what sudo took;
// every sudo step of the session (editor, file panel, installs, recipes) uses it.
import type { SudoChecked, SudoRoute } from "../types";
import { call } from "./call";

/** What is known of sudo on a session, trying no password. */
export function sudoRoute(sessionId: string): Promise<SudoRoute> {
  return call<SudoRoute>("sudo_route", { sessionId });
}

/**
 * Get sudo going on a session: with `password` typed into a prompt, or — `null` —
 * with what the session took or has saved (the sudo password, then the login's).
 * `remember` saves a typed password sudo took in the keychain. Throws the sudo
 * markers `sudoAnswer` reads.
 */
export function sudoCheck(sessionId: string, password: string | null, remember: boolean): Promise<SudoChecked> {
  return call<SudoChecked>("sudo_check", { sessionId, password, remember });
}
