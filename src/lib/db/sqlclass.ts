// What a statement does (ADR 0080): reads, writes, changes the schema, steers
// the transaction or the session. A fuse, not a parser (INVARIANTS principle 7):
// when unsure it says "writes" and asks — an unknown verb, a CTE that hides a
// DELETE, a SET that would lift read-only. It decides only what is asked before
// a run; what runs without read-only lifted, and what the recording says, are
// the backend's (db/sql.rs). A question names the verb and the tables, never
// the values (`auditLine`).

import { tokens, type Dialect, type Token } from "./sqlsplit";

export type SqlClass = "read" | "write" | "ddl" | "admin" | "tx" | "session" | "other";

/** Why a statement is asked about before it runs, on any server. */
export type ConfirmReason = "noWhere" | "drop" | "alter" | "grants";

export interface Classified {
  cls: SqlClass;
  /** The statement's verb, upper-case: `SELECT`, `DELETE`, `CREATE INDEX`. */
  verb: string;
  /** Tables it names, as written (at most five). */
  tables: string[];
  /** Asked about before it runs, whatever the server (null — not). */
  confirm: ConfirmReason | null;
  /** EXPLAIN can show its plan; `analyzable` — and run it (reads only). */
  explainable: boolean;
  analyzable: boolean;
}

const READ = new Set(["SELECT", "SHOW", "VALUES", "TABLE", "DESCRIBE", "DESC", "EXPLAIN", "HELP"]);
const WRITE = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "COPY", "LOAD", "CALL", "DO", "HANDLER", "IMPORT"]);
const DDL = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT", "GRANT", "REVOKE", "SECURITY", "REFRESH", "IMPORT"]);
const ADMIN = new Set(["VACUUM", "ANALYZE", "ANALYSE", "REINDEX", "CLUSTER", "CHECKPOINT", "KILL", "FLUSH", "OPTIMIZE", "REPAIR", "CHECK", "LOCK", "UNLOCK", "PURGE", "RESET", "INSTALL", "UNINSTALL", "SHUTDOWN", "NOTIFY", "LISTEN", "UNLISTEN", "DISCARD", "PREPARE", "EXECUTE", "DEALLOCATE", "CHECKSUM"]);
const TX = new Set(["BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END", "ABORT", "XA"]);
const SESSION = new Set(["SET", "USE"]);

/** Reads by their verb that act: the backend's list is longer and it is the one that holds. */
const ACTING = new Set(["SET_CONFIG", "PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND", "NEXTVAL", "SETVAL", "PG_RELOAD_CONF"]);

const up = (t: Token | undefined): string => (t && t.kind === "word" ? t.text.toUpperCase() : "");

/** The verb a `WITH …` statement ends in: its first top-level verb after the CTEs. */
function withVerb(ts: Token[]): string {
  for (const t of ts.slice(1)) {
    if (t.depth !== 0) continue;
    const w = up(t);
    if (["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE"].includes(w)) return w;
  }
  return "SELECT";
}

/** Names after the words that introduce a table, as written. */
function tablesOf(ts: Token[]): string[] {
  const after = new Set(["FROM", "JOIN", "UPDATE", "INTO", "TABLE", "TRUNCATE"]);
  const skip = new Set(["ONLY", "IF", "EXISTS", "NOT", "LATERAL", "TEMP", "TEMPORARY", "UNLOGGED", "IGNORE", "LOW_PRIORITY", "QUICK", "DELAYED", "HIGH_PRIORITY"]);
  const out: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (!after.has(up(ts[i]))) continue;
    let j = i + 1;
    while (j < ts.length && skip.has(up(ts[j]))) j++;
    const t = ts[j];
    if (!t || (t.kind !== "word" && t.kind !== "quoted")) continue;
    if (READ.has(up(t)) || up(t) === "SELECT") continue;
    if (!out.includes(t.text)) out.push(t.text);
    if (out.length >= 5) break;
  }
  return out;
}

/** Whether a `SET` would lift read-only — that is a write in disguise. */
function liftsReadOnly(ts: Token[]): boolean {
  const words = ts.map((t) => (t.kind === "word" ? t.text.toUpperCase() : t.kind === "string" ? t.text.toUpperCase() : t.text));
  const text = words.join(" ");
  return (
    /READ\s+WRITE/.test(text) ||
    /(TRANSACTION_READ_ONLY|DEFAULT_TRANSACTION_READ_ONLY|TX_READ_ONLY)\s*(=|TO)\s*('?(OFF|FALSE|0)'?)/.test(text) ||
    /\bROLE\b/.test(text) ||
    /\bAUTOCOMMIT\b/.test(text) ||
    /SESSION\s+AUTHORIZATION/.test(text)
  );
}

/** MySQL runs what `/*! … *\/` holds, and which server does is its version: not a read. */
const hasExecutableComment = (sql: string, dialect: Dialect): boolean => dialect === "mysql" && /\/\*M?!/.test(sql);

/** What one statement does. */
export function classify(sql: string, dialect: Dialect): Classified {
  const ts = tokens(sql, dialect);
  const first = up(ts[0]);
  let verb = first;
  let cls: SqlClass;
  if (first === "WITH") {
    verb = withVerb(ts);
    // A CTE may hold a writing statement of its own: `WITH x AS (DELETE …)`.
    const writesInside = ts.some((t) => ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(up(t)));
    cls = writesInside || verb !== "SELECT" ? "write" : "read";
  } else if (first === "EXPLAIN" || first === "DESCRIBE" || first === "DESC") {
    // EXPLAIN ANALYZE runs what it explains.
    const analyze = ts.slice(1, 6).some((t) => ["ANALYZE", "ANALYSE"].includes(up(t)));
    const inner = ts.find((t, i) => i > 0 && t.depth === 0 && (WRITE.has(up(t)) || ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(up(t))));
    cls = analyze && inner ? "write" : "read";
  } else if (first === "SELECT") {
    // SELECT … INTO a new table (PostgreSQL) writes; INTO a variable or OUTFILE too.
    cls = ts.some((t) => t.depth === 0 && up(t) === "INTO") ? "write" : "read";
  } else if (READ.has(first)) cls = "read";
  else if (first === "START" && up(ts[1]) !== "TRANSACTION") cls = "admin";
  else if (TX.has(first)) cls = liftsReadOnly(ts) ? "write" : "tx";
  else if (SESSION.has(first)) cls = liftsReadOnly(ts) ? "write" : "session";
  else if (WRITE.has(first)) cls = "write";
  else if (DDL.has(first)) cls = "ddl";
  else if (ADMIN.has(first)) cls = "admin";
  else cls = "other";

  if (cls === "read" && (hasExecutableComment(sql, dialect) || ts.some((t) => ACTING.has((t.kind === "quoted" ? t.text.slice(1, -1) : t.text).toUpperCase())))) cls = "write";

  if (cls === "ddl" || first === "CREATE" || first === "DROP" || first === "ALTER") {
    // `CREATE INDEX`, `DROP TABLE`: the verb and what it is about.
    const what = up(ts[1]);
    if (what && !["IF", "OR"].includes(what)) verb = `${first} ${what === "UNIQUE" ? `UNIQUE ${up(ts[2])}` : what}`;
  }

  let confirm: ConfirmReason | null = null;
  if (cls === "write" && ["UPDATE", "DELETE"].includes(verb) && !ts.some((t) => t.depth === 0 && up(t) === "WHERE")) confirm = "noWhere";
  else if (first === "DROP" || first === "TRUNCATE") confirm = "drop";
  else if (first === "ALTER" || first === "RENAME") confirm = "alter";
  else if (first === "GRANT" || first === "REVOKE") confirm = "grants";

  const explainable = ["SELECT", "INSERT", "UPDATE", "DELETE", "VALUES", "TABLE", "MERGE", "REPLACE"].includes(verb) && first !== "EXPLAIN";
  return {
    cls,
    verb: verb || "?",
    tables: tablesOf(ts),
    confirm,
    explainable,
    analyzable: explainable && cls === "read",
  };
}

/** Whether a statement writes in any way — on a read-only connection it needs the lock lifted. */
export const writes = (c: Classified): boolean => c.cls === "write" || c.cls === "ddl" || c.cls === "admin" || c.cls === "other";

/** What a question calls a statement: its verb and its tables. The recording's line is the backend's. */
export function auditLine(c: Classified): string {
  return c.tables.length ? `${c.verb} ${c.tables.join(", ")}` : c.verb;
}
