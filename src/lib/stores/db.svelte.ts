// Databases (ADR 0080): the profiles, and what each database document of a
// connection holds — its own database connection, its last answer, its plan,
// its edits, its activity. A document's connection is its own: a console's
// statement and the activity view's reading never queue behind each other.
// Statements of one document run one at a time (`serial`): the app's own
// catalog and meta queries wait for the user's and the other way round.
//
// It closes with the document (`closeDbDoc`), the tab (`forgetDb` in
// `closeTabFully`) and the session (the backend closes it with `end_session`).
// Only this store calls the database commands (`vterm/owned-imports`).

import { dbApply, dbCancel, dbClose, dbConnect, dbForgetPassword, dbLocalList, dbQuery, dbSaveLocal, setServerDatabases } from "../api/db";
import { nullWrittenByCall, writtenByCall } from "../api/call";
import { swallowed } from "../api/diag";
import { diag } from "../api/diag";
import type { DbKind, DbOpened, DbOutcome, DbProfile, DbTx, ServerProfile } from "../types";
import { settings } from "../settings/settings.svelte";
import { classify, writes, type Classified } from "../db/sqlclass";
import { applyFailureText, dbFailure, failureText, type DbFailure } from "../db/dberror";
import { CATALOG_MAX, catalogQueries, indexesSql, parseColumns, parseIndexes, parseRoutines, parseTableMeta, parseTables, tableMetaSql, type Catalog } from "../db/dbcatalog";
import { explainSql, flatten, parsePlan, resolveAliases, type Plan } from "../db/dbplan";
import { editCount, editStatements, editTarget, NO_EDITS, setCell, sourceTable, toggleDelete, type Edits, type EditTarget, type NotEditable } from "../db/dbedit";
import {
  activityQueries,
  MY_SESSIONS_PLAIN,
  parseReplicas,
  parseSessions,
  parseStatements,
  parseStats,
  cancelSql,
  stopReached,
  terminateSql,
  type Activity,
} from "../db/dbactivity";

export type DbView = "console" | "activity";

export interface DbConnInfo {
  id: string;
  version: string;
  readOnly: boolean;
  prod: boolean;
}

export interface DbResult {
  statement: string;
  cls: Classified;
  outcome: DbOutcome;
  at: number;
}

export interface DbPlanState {
  statement: string;
  analyze: boolean;
  plan: Plan | null;
  /** What the server answered, shown as a table when it is not a plan we read (MariaDB). */
  raw: DbOutcome | null;
  error: string | null;
  /** Each scanned table's indexes (leading column first), for the advice; null — not read. */
  indexes: Record<string, string[][] | null>;
}

export interface DbEditState {
  target: EditTarget | NotEditable | null;
  edits: Edits;
  applying: boolean;
  error: string | null;
}

export interface DbActivityState {
  data: Activity | null;
  at: number | null;
  failedAt: number | null;
  error: string | null;
  /** What could not be read, in the server's words: lock waits, replicas, statements. */
  notes: Partial<Record<"sessions" | "locks" | "replicas" | "statements", string>>;
}

export interface DbDocState {
  sessionId: string;
  place: string | null;
  dbId: string;
  kind: DbKind;
  view: DbView;
  conn: DbConnInfo | null;
  status: "connecting" | "password" | "ready" | "failed" | "closed";
  failure: DbFailure | null;
  running: { statement: string; since: number } | null;
  result: DbResult | null;
  plan: DbPlanState | null;
  edit: DbEditState;
  history: string[];
  tx: "auto" | "manual";
  /** The transaction as the backend last said it stands. */
  txState: DbTx;
  /** The server reads `\` in a string as an escape (MySQL's default). */
  backslashEscapes: boolean;
  /** A statement to run once connected ("first rows" of a table); cleared when it ran. */
  autorun: string | null;
  activity: DbActivityState | null;
}

export interface DbCatalogState {
  catalog: Catalog | null;
  loading: boolean;
  error: string | null;
}

// Raw, replaced whole: an answer holds up to ten thousand rows, and a deep
// proxy over each of their cells is work for nothing — nothing edits them in place.
let docs = $state.raw<Record<string, DbDocState>>({});
let catalogs = $state.raw<Record<string, DbCatalogState>>({});
let local = $state.raw<DbProfile[]>([]);

function putDoc(docId: string, d: DbDocState | null): void {
  const next = { ...docs };
  if (d) next[docId] = d;
  else delete next[docId];
  docs = next;
}

function putCatalog(key: string, c: DbCatalogState): void {
  catalogs = { ...catalogs, [key]: c };
}

/** The most statements a console remembers. */
export const HISTORY_MAX = 100;

// ── Profiles ──────────────────────────────────────────────────────────────────

/** The databases of this computer. */
export const localDbs = (): DbProfile[] => local;

/** A place's databases: a server's from its profile, this computer's from the store. */
export function profilesOf(place: string | null, servers: readonly ServerProfile[]): DbProfile[] {
  if (place === null) return local;
  return servers.find((s) => s.id === place)?.databases ?? [];
}

export async function loadLocalDbs(): Promise<void> {
  const got = await dbLocalList().catch(nullWrittenByCall);
  if (got) local = got;
}

/** Keep a place's databases as listed; the backend's answer is what stands. */
export async function saveDbProfiles(place: string | null, list: DbProfile[]): Promise<void> {
  if (place === null) local = await dbSaveLocal(list);
  else await setServerDatabases(place, list);
  diag.info("db", "database profiles saved", { count: list.length, local: place === null });
}

export async function forgetDbPassword(place: string | null, dbId: string): Promise<void> {
  await dbForgetPassword(place, dbId);
  if (place === null) await loadLocalDbs();
}

// ── Documents ─────────────────────────────────────────────────────────────────

export const dbDoc = (docId: string): DbDocState | null => docs[docId] ?? null;

const catalogKey = (place: string | null, dbId: string) => `${place ?? "local"}/${dbId}`;

export const catalogOf = (place: string | null, dbId: string): DbCatalogState | null => catalogs[catalogKey(place, dbId)] ?? null;

/** Whether a document of the place's database has a live connection (the tree reads its catalog then). */
export function openDocOf(place: string | null, dbId: string): string | null {
  for (const [id, d] of Object.entries(docs)) if (d.place === place && d.dbId === dbId && d.view === "console" && d.conn) return id;
  return null;
}

function patch(docId: string, next: Partial<DbDocState>): void {
  const d = docs[docId];
  if (d) putDoc(docId, { ...d, ...next });
}

/** Start tracking a document (its connection comes with `connectDb`). */
export function attachDb(
  docId: string,
  init: { sessionId: string; place: string | null; dbId: string; kind: DbKind; view: DbView; autorun?: string | null },
): void {
  if (docs[docId]) return;
  putDoc(docId, {
    ...init,
    autorun: init.autorun ?? null,
    conn: null,
    status: "connecting",
    failure: null,
    running: null,
    result: null,
    plan: null,
    edit: { target: null, edits: NO_EDITS, applying: false, error: null },
    history: [],
    tx: "auto",
    txState: "none",
    backslashEscapes: init.kind === "mysql",
    activity: init.view === "activity" ? { data: null, at: null, failedAt: null, error: null, notes: {} } : null,
  });
}

const queues = new Map<string, Promise<unknown>>();

/** Run `work` after whatever the document is running: one statement at a time. */
function serial<T>(docId: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(docId) ?? Promise.resolve();
  const next = before.then(work, work);
  queues.set(
    docId,
    next.catch((error) => {
      swallowed("db", "the previous database operation failed before the next one", error);
    }),
  );
  return next;
}

/** What an answer says of the connection itself. */
function stands(docId: string, o: DbOutcome): void {
  const d = docs[docId];
  if (d && (d.txState !== o.tx || d.backslashEscapes !== o.backslashEscapes)) patch(docId, { txState: o.tx, backslashEscapes: o.backslashEscapes });
}

/** A query of the app's own (catalog, meta, activity): its answer, or null — the doc said why. */
async function quiet(docId: string, sql: string, rows = 10_000): Promise<DbOutcome | null> {
  const d = docs[docId];
  if (!d?.conn) return null;
  try {
    const out = await dbQuery(d.conn.id, sql, rows, false);
    stands(docId, out);
    return out;
  } catch (e) {
    lost(docId, e);
    return null;
  }
}

/** A refusal of a command: the connection is gone — say so on the document. */
function lost(docId: string, e: unknown): DbFailure {
  const f = dbFailure(e);
  if (f.kind === "closed" || f.kind === "noSession") patch(docId, { conn: null, status: "closed", failure: f, running: null, txState: "none" });
  return f;
}

/** Documents whose connection is on its way: not a second one, and their tab waits before it moves. */
const opening = new Set<string>();

/**
 * Connect a document — one that is connected stays as it is. `password` — typed
 * now (null: the saved one, if any).
 */
export async function connectDb(docId: string, password: string | null = null, remember = false): Promise<void> {
  const d = docs[docId];
  if (!d || d.conn || opening.has(docId)) return;
  opening.add(docId);
  patch(docId, { status: "connecting", failure: null });
  let opened: DbOpened;
  try {
    opened = await dbConnect(d.sessionId, d.dbId, password || null, remember);
  } catch (e) {
    const f = dbFailure(e);
    patch(docId, { status: f.kind === "auth" ? "password" : "failed", failure: f });
    return;
  } finally {
    opening.delete(docId);
  }
  if (!docs[docId]) {
    // Closed while it connected.
    void dbClose(opened.connId).catch(writtenByCall);
    return;
  }
  patch(docId, { conn: { id: opened.connId, version: opened.version, readOnly: opened.readOnly, prod: opened.prod }, status: "ready", failure: null });
  if (opened.rememberFailed) diag.warn("db", "the database password was not kept in the keychain: the next connection asks again");
  if (d.view === "console") void loadCatalog(d.place, d.dbId, docId);
  const autorun = docs[docId]?.autorun ?? null;
  if (autorun) {
    patch(docId, { autorun: null });
    await runSql(docId, autorun);
  }
}

/** What a statement needs before it runs: the lock lifted, a question — or nothing. */
export interface RunCheck {
  cls: Classified;
  /** It writes and the connection is read-only: it runs only with the lock lifted. */
  lift: boolean;
  /** Asked about on any server (`ConfirmReason`), or because it lifts the lock. */
  ask: boolean;
}

export function checkRun(docId: string, statement: string): RunCheck | null {
  const d = docs[docId];
  if (!d?.conn) return null;
  const cls = classify(statement, d.kind);
  const lift = d.conn.readOnly && writes(cls);
  return { cls, lift, ask: lift || cls.confirm !== null };
}

/** What a run came to; `readOnly` — it needs the lock lifted and was not run: ask, then run it again `writable`. */
export type RunAnswer = DbResult | "readOnly" | null;

/**
 * Run one statement (after its question was answered, if it had one).
 * `writable` — the lock is lifted for it.
 */
export function runSql(docId: string, statement: string, writable = false): Promise<RunAnswer> {
  return serial(docId, async () => {
    const d = docs[docId];
    if (!d?.conn) return null;
    const cls = classify(statement, d.kind);
    patch(docId, { running: { statement, since: Date.now() }, failure: null });
    let begun = false;
    // A lifted statement stands alone: the lock does not lift inside a transaction.
    if (d.tx === "manual" && d.txState === "none" && !writable && cls.cls !== "tx") {
      const out = await quiet(docId, d.kind === "postgres" ? "BEGIN" : "START TRANSACTION", 1);
      if (!out) {
        patch(docId, { running: null });
        return null;
      }
      if (out.error) {
        const result: DbResult = { statement, cls, outcome: out, at: Date.now() };
        patch(docId, { running: null, result });
        return result;
      }
      begun = true;
    }
    let outcome: DbOutcome;
    try {
      outcome = await dbQuery(d.conn.id, statement, settings.dbMaxRows, writable);
    } catch (e) {
      const f = lost(docId, e);
      // Nothing ran: the transaction opened for it goes too.
      if (begun && f.kind !== "closed") await quiet(docId, "ROLLBACK", 1);
      const needsLift = f.kind === "readOnly" && !writable;
      patch(docId, { running: null, failure: needsLift ? null : f });
      return needsLift ? "readOnly" : null;
    }
    stands(docId, outcome);
    const now = docs[docId];
    if (!now) return null;
    const history = [statement, ...now.history.filter((h) => h !== statement)].slice(0, HISTORY_MAX);
    const result: DbResult = { statement, cls, outcome, at: Date.now() };
    patch(docId, {
      running: null,
      result,
      history,
      edit: { target: null, edits: NO_EDITS, applying: false, error: null },
    });
    // A schema change makes the tree and the completion stale.
    if (!outcome.error && cls.cls === "ddl") void loadCatalog(now.place, now.dbId, docId);
    return result;
  });
}

/** Stop what the document is running. */
export async function cancelDb(docId: string): Promise<void> {
  const d = docs[docId];
  if (!d?.conn || !d.running) return;
  try {
    await dbCancel(d.conn.id);
  } catch (e) {
    lost(docId, e);
  }
}

/** Auto-commit or a transaction of the user's: switching back ends the open one first (the caller asked). */
export function setTxMode(docId: string, tx: "auto" | "manual"): void {
  patch(docId, { tx });
}

// ── Plan ──────────────────────────────────────────────────────────────────────

/**
 * The plan of a statement. `analyze` runs it — for a read only (the console
 * offers it for those). MariaDB has no tree: its classic EXPLAIN is shown as is.
 */
export function planOf(docId: string, statement: string, analyze: boolean): Promise<void> {
  return serial(docId, async () => {
    const d = docs[docId];
    if (!d?.conn) return;
    patch(docId, { running: { statement, since: Date.now() } });
    let out = await quiet(docId, explainSql(d.kind, statement, analyze), 5000);
    let raw: DbOutcome | null = null;
    if (out?.error && d.kind === "mysql") {
      // No tree here (MariaDB): the plan as the server's own table.
      const classic = await quiet(docId, `${analyze ? "ANALYZE" : "EXPLAIN"} ${statement}`, 500);
      if (classic && !classic.error) {
        raw = classic;
        out = null;
      }
    }
    const plan = out && !out.error ? parsePlan(d.kind, out) : null;
    if (plan && d.kind === "mysql") resolveAliases(plan, statement);
    const indexes: Record<string, string[][] | null> = {};
    if (plan) {
      const current = catalogs[catalogKey(d.place, d.dbId)]?.catalog?.current ?? (d.kind === "postgres" ? "public" : null);
      for (const { node } of flatten(plan.root)) {
        const rel = node.warn?.kind === "seqScan" ? node.warn.relation : null;
        if (!rel || rel.name in indexes) continue;
        const schema = rel.schema ?? current;
        const ix = schema ? await quiet(docId, indexesSql(d.kind, schema, rel.name), 200) : null;
        indexes[rel.name] = ix && !ix.error ? parseIndexes(ix) : null;
      }
    }
    patch(docId, {
      running: null,
      plan: { statement, analyze, plan, raw, indexes, error: out?.error?.message ?? (plan || raw ? null : "unreadable") },
    });
  });
}

// ── Edits ─────────────────────────────────────────────────────────────────────

/** Find out whether the last answer can be edited (its table's key) — once, when first asked. */
export function prepareEdit(docId: string): Promise<void> {
  return serial(docId, async () => {
    const d = docs[docId];
    // A failed look at the table is taken again.
    if (!d?.result || (d.edit.target !== null && d.edit.target !== "metaFailed")) return;
    const { outcome, statement } = d.result;
    let target: EditTarget | NotEditable;
    const src = sourceTable(outcome);
    if (!outcome.read && outcome.columns.length > 0) target = "notRead";
    else if (d.txState !== "none") target = "inTx";
    else if (["computed", "manyTables", "notRows"].includes(src)) target = src as NotEditable;
    else {
      const meta = await quiet(docId, tableMetaSql(d.kind, src), 2000);
      target = editTarget(outcome, src, meta && !meta.error ? parseTableMeta(meta) : null, d.kind, statement);
    }
    const now = docs[docId];
    if (now?.result?.outcome === outcome) patch(docId, { edit: { ...now.edit, target } });
  });
}

function setEdits(docId: string, edits: Edits): void {
  const d = docs[docId];
  if (d && !d.edit.applying) patch(docId, { edit: { ...d.edit, edits, error: null } });
}

export function editDbCell(docId: string, row: number, col: number, value: string | null): void {
  const d = docs[docId];
  if (d?.result && d.edit.target && typeof d.edit.target !== "string") setEdits(docId, setCell(d.edit.edits, d.result.outcome, row, col, value));
}

export function toggleDbRowDelete(docId: string, row: number): void {
  const d = docs[docId];
  if (d?.edit.target && typeof d.edit.target !== "string") setEdits(docId, toggleDelete(d.edit.edits, row));
}

export function discardDbEdits(docId: string): void {
  setEdits(docId, NO_EDITS);
}

/** The statements the pending edits become (shown before they run). */
export function pendingStatements(docId: string): string[] {
  const d = docs[docId];
  if (!d?.result || !d.edit.target || typeof d.edit.target === "string") return [];
  return editStatements(d.result.outcome, d.edit.target, d.edit.edits, d.kind, d.backslashEscapes);
}

export const pendingCount = (docId: string): number => {
  const d = docs[docId];
  return d ? editCount(d.edit.edits) : 0;
};

/**
 * Apply the pending edits in one transaction (`writable` — the lock lifted for
 * it, the user agreed). Applied — the read that gave the rows runs again, so the
 * grid shows what the table now holds; a statement that changed something never does.
 */
export function applyDbEdits(docId: string, writable: boolean): Promise<boolean> {
  return serial(docId, async () => {
    const d = docs[docId];
    if (!d?.conn || !d.result?.outcome.read || !d.edit.target || typeof d.edit.target === "string") return false;
    const statements = editStatements(d.result.outcome, d.edit.target, d.edit.edits, d.kind, d.backslashEscapes);
    if (statements.length === 0) return false;
    patch(docId, { edit: { ...d.edit, applying: true, error: null } });
    let error: string | null = null;
    try {
      const { failure } = await dbApply(d.conn.id, statements, writable);
      if (failure) error = applyFailureText(failure);
    } catch (e) {
      error = failureText(lost(docId, e));
    }
    const now = docs[docId];
    if (!now) return error === null;
    if (error !== null) {
      patch(docId, { edit: { ...now.edit, applying: false, error } });
      return false;
    }
    const statement = d.result.statement;
    patch(docId, { edit: { target: null, edits: NO_EDITS, applying: false, error: null } });
    diag.info("db", "table edits applied", { count: statements.length });
    // Read again, outside this turn of the queue.
    queueMicrotask(() => void runSql(docId, statement));
    return true;
  });
}

// ── Activity ──────────────────────────────────────────────────────────────────

/** Read the activity once (the view polls while it is on screen). */
export function readActivity(docId: string): Promise<void> {
  return serial(docId, async () => {
    const d = docs[docId];
    if (!d?.conn || !d.activity) return;
    const q = activityQueries(d.kind, d.conn.version);
    const notes: DbActivityState["notes"] = {};
    let sessions = await quiet(docId, q.sessions, 600);
    if (sessions?.error && d.kind === "mysql") {
      notes.sessions = sessions.error.message;
      sessions = await quiet(docId, MY_SESSIONS_PLAIN, 600);
    }
    const stats = await quiet(docId, q.stats, 1);
    if (!sessions || sessions.error || !stats || stats.error) {
      const now = docs[docId];
      if (now?.activity)
        patch(docId, { activity: { ...now.activity, failedAt: Date.now(), error: sessions?.error?.message ?? stats?.error?.message ?? failureText({ kind: "closed" }) } });
      return;
    }
    let locks: DbOutcome | null = null;
    if (q.locks) {
      locks = await quiet(docId, q.locks, 1000);
      if (locks?.error) {
        notes.locks = locks.error.message;
        locks = null;
      }
    }
    const status = q.status ? await quiet(docId, q.status, 10) : null;
    const replicasOut = await quiet(docId, q.replicas, 100);
    if (replicasOut?.error) notes.replicas = replicasOut.error.message;
    const statementsOut = await quiet(docId, q.statements, 20);
    if (statementsOut?.error) notes.statements = statementsOut.error.message;
    const base = parseStats(stats, status && !status.error ? status : null);
    const rep = replicasOut && !replicasOut.error ? parseReplicas(d.kind, replicasOut) : null;
    const data: Activity = {
      ...base,
      replica: base.replica || (rep?.isReplica ?? false),
      replayLagS: base.replayLagS ?? rep?.lagS ?? null,
      replicas: rep ? rep.replicas : null,
      sessions: parseSessions(d.kind, sessions, locks),
      statements: statementsOut && !statementsOut.error ? parseStatements(statementsOut) : null,
    };
    patch(docId, { activity: { data, at: Date.now(), failedAt: null, error: null, notes } });
  });
}

/** What stopping a session came to. */
export type StopAnswer = { done: true } | { done: false; missing: boolean; error: string | null };

/** Stop a session's statement, or end the session (the user agreed; on a prod server — in red). */
export function stopDbSession(docId: string, sessionId: string, terminate: boolean): Promise<StopAnswer> {
  return serial<StopAnswer>(docId, async () => {
    const d = docs[docId];
    if (!d?.conn) return { done: false, missing: false, error: failureText({ kind: "closed" }) };
    const sql = terminate ? terminateSql(d.kind, sessionId) : cancelSql(d.kind, sessionId);
    try {
      // The question before it is the consent to lift read-only for it.
      const out = await dbQuery(d.conn.id, sql, 1, d.conn.readOnly);
      if (out.error) return { done: false, missing: false, error: out.error.message };
      return stopReached(d.kind, out) ? { done: true } : { done: false, missing: true, error: null };
    } catch (e) {
      return { done: false, missing: false, error: failureText(lost(docId, e)) };
    }
  });
}

// ── Catalog ───────────────────────────────────────────────────────────────────

/** Read a database's catalog over a document's connection. */
export function loadCatalog(place: string | null, dbId: string, docId: string): Promise<void> {
  const key = catalogKey(place, dbId);
  const had = catalogs[key];
  putCatalog(key, { catalog: had?.catalog ?? null, loading: true, error: null });
  return serial(docId, async () => {
    const d = docs[docId];
    if (!d?.conn) {
      putCatalog(key, { catalog: had?.catalog ?? null, loading: false, error: null });
      return;
    }
    const q = catalogQueries(d.kind);
    const current = await quiet(docId, q.current, 1);
    const tables = await quiet(docId, q.tables, CATALOG_MAX);
    const routines = await quiet(docId, q.routines, CATALOG_MAX);
    const columns = await quiet(docId, q.columns, CATALOG_MAX);
    if (!tables || tables.error) {
      putCatalog(key, { catalog: had?.catalog ?? null, loading: false, error: tables?.error?.message ?? failureText({ kind: "closed" }) });
      return;
    }
    putCatalog(key, {
      catalog: {
        tables: parseTables(d.kind, tables),
        routines: routines && !routines.error ? parseRoutines(routines) : [],
        columns: columns && !columns.error ? parseColumns(columns) : {},
        current: current?.rows[0]?.[0] ?? null,
        cut: !!(tables.truncated || routines?.truncated || columns?.truncated),
      },
      loading: false,
      error: null,
    });
  });
}

// ── Lifetime ──────────────────────────────────────────────────────────────────

/** Close a document's connection and forget it. */
export function closeDbDoc(docId: string): void {
  const d = docs[docId];
  if (!d) return;
  if (d.conn) void dbClose(d.conn.id).catch(writtenByCall);
  queues.delete(docId);
  putDoc(docId, null);
}

/** A tab closed: its documents' connections with it. */
export function forgetDb(sessionId: string): void {
  for (const [id, d] of Object.entries(docs)) if (d.sessionId === sessionId) closeDbDoc(id);
}

/** Whether a tab is running a statement or connecting: it cannot move to another window mid-way. */
export function dbRunning(sessionId: string): boolean {
  return Object.entries(docs).some(([id, d]) => d.sessionId === sessionId && (d.running !== null || d.edit.applying || opening.has(id)));
}

/** What closing a document would lose: a statement on its way, an open transaction, edits not applied. */
export type DbWork = "running" | "tx" | "edits";

export function dbWork(docId: string): DbWork | null {
  const d = docs[docId];
  if (!d) return null;
  if (d.running || d.edit.applying) return "running";
  if (d.conn && d.txState !== "none") return "tx";
  return editCount(d.edit.edits) > 0 ? "edits" : null;
}

/** The documents of a tab whose work would be lost with it. */
export function dbWorking(sessionId: string): string[] {
  return Object.keys(docs).filter((id) => docs[id].sessionId === sessionId && dbWork(id) !== null);
}

/** A tab's documents, for its trip to another window. */
export function peekDb(sessionId: string): Record<string, DbDocState> {
  return Object.fromEntries(Object.entries(docs).filter(([, d]) => d.sessionId === sessionId));
}

/** A tab's documents arrived from another window: the connections are the backend's and stay open. */
export function adoptDb(arrived: Record<string, DbDocState> | undefined): void {
  for (const [id, d] of Object.entries(arrived ?? {})) {
    putDoc(id, { ...d, running: null });
    // The catalog is this window's own: it has none of this database yet.
    if (d.conn && d.view === "console" && !catalogs[catalogKey(d.place, d.dbId)]) void loadCatalog(d.place, d.dbId, id);
  }
}

/** A tab went to another window: its documents' state goes from here, their connections stay (the other window has them). */
export function dropDb(sessionId: string): void {
  for (const [id, d] of Object.entries(docs)) {
    if (d.sessionId !== sessionId) continue;
    queues.delete(id);
    putDoc(id, null);
  }
}

/** What the panel is asked from outside: a new profile (⌘K, the Docker panel), with a start. */
export const dbAsk = $state<{ seq: number; place: string | null; profile: DbProfile | null }>({ seq: 0, place: null, profile: null });

export function askNewDb(place: string | null, profile: DbProfile | null = null): void {
  dbAsk.place = place;
  dbAsk.profile = profile;
  dbAsk.seq++;
}

/** The panel took what it was asked: mounted again, it is not asked twice. */
export function tookDbAsk(): void {
  dbAsk.seq = 0;
  dbAsk.profile = null;
}
