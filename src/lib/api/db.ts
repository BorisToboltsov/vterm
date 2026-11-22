// Databases (ADR 0080): the window names a tab and a database id; the address,
// the password and whether it may write are the backend's. Only the store
// `stores/db` calls these (`vterm/owned-imports`).
import type { DbApplied, DbConnect, DbOutcome, DbProfile, ServerProfile } from "../types";
import { call } from "./call";

/** The databases of this computer. */
export function dbLocalList(): Promise<DbProfile[]> {
  return call<DbProfile[]>("db_local_list");
}

/** Keep the databases of this computer; the backend answers what it kept. */
export function dbSaveLocal(databases: DbProfile[]): Promise<DbProfile[]> {
  return call<DbProfile[]>("db_save_local", { databases });
}

/** Keep a server's databases; the profile as it now stands. */
export function setServerDatabases(id: string, databases: DbProfile[]): Promise<ServerProfile> {
  return call<ServerProfile>("set_server_databases", { id, databases });
}

/** Forget a database's saved password (`place` — its server, null — this computer). */
export function dbForgetPassword(place: string | null, dbId: string): Promise<void> {
  return call<void>("db_forget_password", { place, dbId });
}

/** Connect to a database of the tab's server (or of this computer, for a local tab). */
export function dbConnect(sessionId: string, dbId: string, password: string | null, remember: boolean): Promise<DbConnect> {
  return call<DbConnect>("db_connect", { sessionId, dbId, password, remember });
}

/**
 * Run one statement: at most `rows` rows; `writable` — the user agreed to lift
 * read-only for it alone. What needs that and the recording's line are the backend's.
 */
export function dbQuery(connId: string, sql: string, rows: number, writable: boolean): Promise<DbOutcome> {
  return call<DbOutcome>("db_query", { connId, sql, rows, writable });
}

/** Apply edits in one transaction; each statement must change exactly one row. */
export function dbApply(connId: string, statements: string[], writable: boolean): Promise<DbApplied> {
  return call<DbApplied>("db_apply", { connId, statements, writable });
}

export function dbCancel(connId: string): Promise<void> {
  return call<void>("db_cancel", { connId });
}

export function dbClose(connId: string): Promise<void> {
  return call<void>("db_close", { connId });
}
