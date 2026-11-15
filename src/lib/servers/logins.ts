// The logins of a server (ADR 0074): the profile's own user is its first login
// (id ""), `logins` are the others, one of them is the default. A tab connects
// with one of them, or with a user typed for that connection only. Pure: what
// the form, the tree's menu, the quick picker and the tab strip show is decided
// here; the backend resolves a choice against the profile (`resolve_login`).

import type { AuthMethod, ServerLogin, ServerProfile, TabLogin } from "../types";

/** The id of a server's first login — the profile's own user. */
export const FIRST = "";

/** A login as the windows show it, the first one included. */
export interface LoginRow {
  id: string;
  username: string;
  authMethod: AuthMethod;
  keyPath: string | null;
  hasSavedPassword: boolean;
  hasSavedSudo: boolean;
}

/** Every login of a server, the first one first. A profile of an older build has one. */
export function serverLogins(s: ServerProfile): LoginRow[] {
  const first: LoginRow = {
    id: FIRST,
    username: s.username,
    authMethod: s.authMethod,
    keyPath: s.keyPath,
    hasSavedPassword: s.hasSavedPassword,
    hasSavedSudo: s.hasSavedSudo ?? false,
  };
  return [first, ...(s.logins ?? [])];
}

/** The login a plain connect uses; a default that is gone is the first. */
export function defaultLoginId(s: ServerProfile): string {
  const id = s.defaultLogin ?? FIRST;
  return (s.logins ?? []).some((l) => l.id === id) ? id : FIRST;
}

/** A login of the server by its id, or null when it is gone. */
export function loginById(s: ServerProfile, id: string): LoginRow | null {
  return serverLogins(s).find((l) => l.id === id) ?? null;
}

/** The choice of a plain connect: the default login, by id. */
export const defaultChoice = (s: ServerProfile): TabLogin => ({ id: defaultLoginId(s) });

/** Whether a plain connect asks which login first (the profile says so, and there is a choice). */
export const asksLogin = (s: ServerProfile): boolean => !!s.askLogin;

/** The user a choice logs in as, or null when its login is gone from the profile. */
export function choiceUser(s: ServerProfile, choice: TabLogin | undefined): string | null {
  if (!choice) return loginById(s, defaultLoginId(s))?.username ?? null;
  if ("once" in choice) return choice.once.trim();
  return loginById(s, choice.id)?.username ?? null;
}

/**
 * The user a tab's title names before the server's alias (`deploy@web-01`): only
 * when it is not the default login — a tab of the default reads as it always
 * did. A login that is gone names nothing; the tab says why it waits.
 */
export function tabUser(s: ServerProfile | undefined, choice: TabLogin | undefined): string | null {
  if (!s || !choice) return null;
  if ("once" in choice) return choice.once.trim() || null;
  if (choice.id === defaultLoginId(s)) return null;
  return loginById(s, choice.id)?.username ?? null;
}

/** Whether a tab's choice keeps what it needs in the keychain (a one-off login keeps nothing). */
export function savedPasswordOf(s: ServerProfile, choice: TabLogin | undefined): boolean {
  if (choice && "once" in choice) return false;
  return loginById(s, choice?.id ?? defaultLoginId(s))?.hasSavedPassword ?? false;
}

/** A user name `ssh` would take: no spaces, no control characters (`valid_login_user`). */
export function validLoginUser(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 64 && !/[\s\u0000-\u001f\u007f]/.test(n);
}

/** The logins of the server form, as it edits them: the first is the profile's own. */
export interface LoginDraft {
  id: string;
  username: string;
  authMethod: AuthMethod;
  keyPath: string | null;
  /** A password or passphrase typed for it in the form, to save after the profile. */
  secret: string;
  hasSavedPassword: boolean;
  hasSavedSudo: boolean;
}

/** The drafts the form starts from: every login of the server, nothing typed. */
export function draftsOf(s: ServerProfile | null): LoginDraft[] {
  if (!s) return [];
  return serverLogins(s).map((l) => ({ ...l, secret: "" }));
}

/** A new login of the form, with its id named now — its secret is saved under it. */
export function newDraft(id: string = crypto.randomUUID()): LoginDraft {
  return {
    id,
    username: "",
    authMethod: "password",
    keyPath: null,
    secret: "",
    hasSavedPassword: false,
    hasSavedSudo: false,
  };
}

/** What the form sends for the other logins (`NewServerLogin`): the first goes as the profile's own fields. */
export function otherLogins(drafts: readonly LoginDraft[]): Pick<ServerLogin, "id" | "username" | "authMethod" | "keyPath">[] {
  return drafts
    .filter((d) => d.id !== FIRST)
    .map((d) => ({ id: d.id, username: d.username.trim(), authMethod: d.authMethod, keyPath: d.authMethod === "key" ? d.keyPath : null }));
}

/** Why the form's logins cannot be saved, or null: an empty user. */
export function draftsProblem(drafts: readonly LoginDraft[]): "emptyUser" | null {
  return drafts.some((d) => d.id !== FIRST && !validLoginUser(d.username)) ? "emptyUser" : null;
}

/** The default after a login is removed: a removed default falls back to the first. */
export function defaultAfter(drafts: readonly LoginDraft[], current: string): string {
  return drafts.some((d) => d.id === current) ? current : FIRST;
}

/** One line of the quick picker: a number to press, the login, whether it is the default. */
export interface PickerItem {
  key: number;
  login: LoginRow;
  isDefault: boolean;
}

/** The quick picker's list: every login, numbered 1–9 in order, the default marked. */
export function pickerItems(s: ServerProfile): PickerItem[] {
  const def = defaultLoginId(s);
  return serverLogins(s).map((login, i) => ({ key: i + 1, login, isDefault: login.id === def }));
}

/** The server after a login's saved password was forgotten (a refused login). */
export function withoutSavedPassword(s: ServerProfile, loginId: string): ServerProfile {
  if (loginId === FIRST) return { ...s, hasSavedPassword: false };
  return { ...s, logins: (s.logins ?? []).map((l) => (l.id === loginId ? { ...l, hasSavedPassword: false } : l)) };
}

/** Whom a plain connect logs in as — the default login's user. */
export const defaultUser = (s: ServerProfile): string => loginById(s, defaultLoginId(s))?.username ?? s.username;

/** Whom a tab of the server logs in as: its login's user, else the default's. */
export const tabLoginName = (s: ServerProfile, choice: TabLogin | undefined): string => choiceUser(s, choice) ?? defaultUser(s);
