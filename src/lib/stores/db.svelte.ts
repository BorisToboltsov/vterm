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
//
// A database's browse connection (ADR 0081) is a document of the store with no
// view of its own (`browseId`): the tree reads the catalog on it, and every
// table document of the tab reads its rows on it, one after another (its
// lane). It ends with the tab, the session, or "Disconnect" — never with a
// table document, which only borrows it.

import { dbApply, dbCancel, dbClose, dbConnect, dbForgetPassword, dbLocalList, dbQuery, dbSaveLocal, setServerDatabases } from "../api/db";
import { nullWrittenByCall, writtenByCall } from "../api/call";
import { swallowed } from "../api/diag";
import { diag } from "../api/diag";
import type { DbConnect, DbKind, DbOutcome, DbProfile, DbTx, ServerProfile } from "../types";
import { settings } from "../settings/settings.svelte";
import { classify, writes, type Classified } from "../db/sqlclass";
import { applyFailureText, dbFailure, errorCodeText, failureText, refusedFailure, type DbFailure } from "../db/dberror";
import { CATALOG_MAX, catalogQueries, indexesSql, parseColumns, parseIndexes, parseKeys, parseRoutines, parseTableMeta, parseTables, tableMetaSql, type Catalog, type TableKind } from "../db/dbcatalog";
import {
  countSql,
  countTail,
  ddlQueries,
  keysOf,
  matchWhere,
  appendPage,
  moreRows,
  pageOf,
  pageSql,
  pageTail,
  rereadRows,
  parseColumns as parseStructColumns,
  parseForeign,
  parseIndexes as parseStructIndexes,
  parseSize,
  readRefusal,
  rowValues,
  shownDdl,
  structureQueries,
  tableDdl,
  tableKey,
  valueQueries,
  VALUE_CHUNK,
  VALUE_MAX,
  viewDdl,
  type ReadRefusal,
  type TableRef,
  type TableStructure,
} from "../db/dbtable";
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

/** A document's view; `browse` — a database's browse connection, shown by no view (ADR 0081). */
export type DbView = "console" | "activity" | "table" | "browse";

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

/** A table document (ADR 0081): what it shows, as the rows on screen were read. */
export interface DbTableState {
  ref: TableRef;
  tableKind: TableKind;
  tab: "data" | "structure" | "ddl";
  /** The filter and the sort of the rows shown. */
  where: string;
  orderBy: string;
  /** The table has rows after those read. */
  hasNext: boolean;
  /** Reading the rows after those shown; `changed` — the table's columns are not those of the rows shown. */
  more: { running: boolean; error: string | null; changed: boolean } | null;
  /** Why the last filter or sort was not run: the document only reads. */
  refusal: ReadRefusal | null;
  /** The exact count, of the filter it was asked with. */
  count: { where: string; n: number | null; running: boolean; error: string | null } | null;
  structure: { data: TableStructure | null; loading: boolean; error: string | null } | null;
  ddl: { text: string | null; how: "server" | "assembled" | "none"; loading: boolean; error: string | null } | null;
  /** A long value read in full, for the value panel. */
  value: { row: number; col: number; text: string | null; loading: boolean; error: string | null; capped: boolean } | null;
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
  activity: DbActivityState | null;
  /** The browse connection a table document reads on; null — its own connection. */
  via: string | null;
  table: DbTableState | null;
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
/** Exact row counts asked for, by `place/db#schema.table`: shown in the tree instead of the estimate. */
let counts = $state.raw<Record<string, number>>({});

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

/** A document of the place's database whose connection reads the catalog: a browse connection, else a console. */
export function openDocOf(place: string | null, dbId: string): string | null {
  let console: string | null = null;
  for (const [id, d] of Object.entries(docs)) {
    if (d.place !== place || d.dbId !== dbId || !d.conn) continue;
    if (d.view === "browse") return id;
    if (d.view === "console") console ??= id;
  }
  return console;
}

/** A tab's browse connection of a database: a document of the store, with no view. */
export const browseId = (sessionId: string, dbId: string): string => `browse:${sessionId}:${dbId}`;

/** The browse connection of a tab, if it was opened. */
export const browseDoc = (sessionId: string, dbId: string): DbDocState | null => docs[browseId(sessionId, dbId)] ?? null;

/** Where a document's statements wait their turn: a table document — on its browse connection's. */
const laneOf = (docId: string): string => docs[docId]?.via ?? docId;

/** The connection a document runs on: its own, or its browse connection's. */
function connOf(d: DbDocState | null | undefined): DbConnInfo | null {
  if (!d) return null;
  return d.via ? (docs[d.via]?.conn ?? null) : d.conn;
}

/** A table document's connection as it stands: its browse connection's state. */
export function tableConn(docId: string): DbDocState | null {
  const via = docs[docId]?.via;
  return via ? (docs[via] ?? null) : null;
}

/** The exact row count of a table, when it was counted. */
export const exactCount = (place: string | null, dbId: string, ref: TableRef): number | null => counts[`${catalogKey(place, dbId)}#${tableKey(ref)}`] ?? null;

function patch(docId: string, next: Partial<DbDocState>): void {
  const d = docs[docId];
  if (d) putDoc(docId, { ...d, ...next });
}

/** Start tracking a document (its connection comes with `connectDb`). */
export function attachDb(
  docId: string,
  init: {
    sessionId: string;
    place: string | null;
    dbId: string;
    kind: DbKind;
    view: DbView;
    /** A table document: the table, and how it opens. */
    table?: { ref: TableRef; tableKind: TableKind; tab?: DbTableState["tab"]; where?: string };
  },
): void {
  if (docs[docId]) return;
  const { table, ...rest } = init;
  putDoc(docId, {
    ...rest,
    via: table ? browseId(init.sessionId, init.dbId) : null,
    table: table
      ? {
          ref: table.ref,
          tableKind: table.tableKind,
          tab: table.tab ?? "data",
          where: table.where ?? "",
          orderBy: "",
          hasNext: false,
          more: null,
          refusal: null,
          count: null,
          structure: null,
          ddl: null,
          value: null,
        }
      : null,
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

/** Run `work` after whatever its lane is running (`laneOf`): one statement at a time on a connection. */
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
  const conn = connOf(docs[docId]);
  if (!conn) return null;
  try {
    const out = await dbQuery(conn.id, sql, rows, false);
    stands(docId, out);
    return out;
  } catch (e) {
    lost(docId, e);
    return null;
  }
}

/** A refusal of a command: the connection is gone — say so on the document (a table's: on its browse connection). */
function lost(docId: string, e: unknown): DbFailure {
  const f = dbFailure(e);
  const owner = docs[docId]?.via ?? docId;
  if (f.kind === "closed" || f.kind === "noSession") patch(owner, { conn: null, status: "closed", failure: f, running: null, txState: "none" });
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
  if (d?.via) {
    // A table document connects its browse connection, which reads it once open.
    if (!docs[d.via]) attachDb(d.via, { sessionId: d.sessionId, place: d.place, dbId: d.dbId, kind: d.kind, view: "browse" });
    if (docs[d.via]?.conn) {
      if (!d.result && !d.running) await readTable(docId);
    } else await connectDb(d.via, password, remember);
    return;
  }
  if (!d || d.conn || opening.has(docId)) return;
  opening.add(docId);
  patch(docId, { status: "connecting", failure: null });
  let got: DbConnect;
  try {
    got = await dbConnect(d.sessionId, d.dbId, password || null, remember);
  } catch (e) {
    const f = dbFailure(e);
    patch(docId, { status: f.kind === "auth" ? "password" : "failed", failure: f });
    return;
  } finally {
    opening.delete(docId);
  }
  const { opened, refused } = got;
  if (!opened) {
    patch(docId, { status: "failed", failure: refused ? refusedFailure(refused) : { kind: "closed" } });
    return;
  }
  if (!docs[docId]) {
    // Closed while it connected.
    void dbClose(opened.connId).catch(writtenByCall);
    return;
  }
  patch(docId, { conn: { id: opened.connId, version: opened.version, readOnly: opened.readOnly, prod: opened.prod }, status: "ready", failure: null });
  if (opened.rememberFailed) diag.warn("db", "the database password was not kept in the keychain: the next connection asks again");
  if (d.view === "console" || d.view === "browse") void loadCatalog(d.place, d.dbId, docId);
  if (d.view === "browse") {
    // The table documents that waited on it.
    for (const [id, x] of Object.entries(docs)) if (x.via === docId && !x.result && !x.running) void readTable(id);
  }
}

/**
 * Open a tab's browse connection of a database (the tree asked, its place's tab
 * being connected): once — a closed or failed one opens again only when asked.
 */
export function openBrowse(sessionId: string, place: string | null, dbId: string, kind: DbKind): string {
  const id = browseId(sessionId, dbId);
  if (!docs[id]) {
    attachDb(id, { sessionId, place, dbId, kind, view: "browse" });
    void connectDb(id);
  }
  return id;
}

/** "Disconnect": the browse connection closes; its table documents say so and can connect it again. */
export function closeBrowse(sessionId: string, dbId: string): void {
  closeDbDoc(browseId(sessionId, dbId));
}

/** What disconnecting a browse connection would lose: a table document's work on it. */
export function browseWork(sessionId: string, dbId: string): DbWork | null {
  const id = browseId(sessionId, dbId);
  for (const [docId, d] of Object.entries(docs)) {
    if (d.via !== id) continue;
    const work = dbWork(docId);
    if (work) return work;
  }
  return null;
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
  const conn = connOf(d);
  // On a shared connection, what runs is this document's only while it says it runs.
  if (!conn || !d?.running) return;
  try {
    await dbCancel(conn.id);
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
  return serial(laneOf(docId), async () => {
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
  return serial(laneOf(docId), async () => {
    const d = docs[docId];
    const conn = connOf(d);
    if (!d || !conn || !d.result?.outcome.read || !d.edit.target || typeof d.edit.target === "string") return false;
    const statements = editStatements(d.result.outcome, d.edit.target, d.edit.edits, d.kind, d.backslashEscapes);
    if (statements.length === 0) return false;
    patch(docId, { edit: { ...d.edit, applying: true, error: null } });
    let error: string | null = null;
    try {
      const { failure } = await dbApply(conn.id, statements, writable);
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
    // Read again, outside this turn of the queue: a table document — the rows it showed.
    queueMicrotask(() => void (d.table ? readTable(docId, {}, "shown") : runSql(docId, statement)));
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
      // The reason is said as a toast, and a toast is the journal: the code alone.
      if (out.error) return { done: false, missing: false, error: errorCodeText(out.error) };
      return stopReached(d.kind, out) ? { done: true } : { done: false, missing: true, error: null };
    } catch (e) {
      return { done: false, missing: false, error: failureText(lost(docId, e)) };
    }
  });
}

// ── Tables (ADR 0081) ─────────────────────────────────────────────────────────

function patchTable(docId: string, next: Partial<DbTableState>): void {
  const d = docs[docId];
  if (d?.table) patch(docId, { table: { ...d.table, ...next } });
}

/**
 * Read a table document's rows from the start — with a new filter or sort when
 * given: a page of them, or (`shown`, a refresh, edits applied) as many as were
 * shown, so the list stays where it was. It only reads: what the user typed is
 * run only as one statement that reads and closes what it opened
 * (`readRefusal`); otherwise the rows stay as they were and the document says
 * why. False — nothing new was read.
 */
export function readTable(docId: string, next: Partial<Pick<DbTableState, "where" | "orderBy">> = {}, extent: "page" | "shown" = "page"): Promise<boolean> {
  return serial(laneOf(docId), async () => {
    const d = docs[docId];
    const conn = connOf(d);
    if (!d?.table || !conn) return false;
    const want = { ...d.table, ...next };
    const page = settings.dbPageRows;
    const rows = extent === "shown" ? rereadRows(d.result?.outcome.rows.length ?? 0, page) : page;
    const sql = pageSql(d.kind, want.ref, want.where, want.orderBy, 0, rows);
    const refusal = readRefusal(d.kind, sql, pageTail(0, rows));
    if (refusal) {
      patchTable(docId, { refusal });
      return false;
    }
    patch(docId, { running: { statement: sql, since: Date.now() }, failure: null });
    let outcome: DbOutcome;
    try {
      outcome = await dbQuery(conn.id, sql, rows + 1, false);
    } catch (e) {
      const f = lost(docId, e);
      // The backend saw a change the classifier here did not: the document does not ask, it only reads.
      if (f.kind === "readOnly") {
        patch(docId, { running: null });
        patchTable(docId, { refusal: "notRead" });
      } else patch(docId, { running: null, failure: f });
      return false;
    }
    stands(docId, outcome);
    const now = docs[docId];
    if (!now?.table) return false;
    const { outcome: shown, hasNext } = pageOf(outcome, rows);
    const filterChanged = want.where !== now.table.where;
    patch(docId, {
      running: null,
      result: { statement: sql, cls: classify(sql, d.kind), outcome: shown, at: Date.now() },
      edit: { target: null, edits: NO_EDITS, applying: false, error: null },
      table: { ...now.table, ...next, hasNext, more: null, refusal: null, value: null, count: filterChanged ? null : now.table.count },
    });
    // Whether its cells may be edited is known before anyone asks: the menu and
    // a double click say "no, and why" at once. After this read, on its lane.
    void prepareEdit(docId);
    return true;
  });
}

/**
 * Read the rows after those a table document shows — the list was scrolled to
 * its end — and add them below: the rows before keep their numbers, so the
 * pending edits, the selection and a value read in full stay. One read at a
 * time, never past `TABLE_ROWS_MAX`, and judged a read like every other.
 * False — nothing was added.
 */
export function readMoreTable(docId: string): Promise<boolean> {
  const d = docs[docId];
  const shown = d?.result?.outcome;
  if (!d?.table || !shown || shown.error || !d.table.hasNext || d.table.more?.running || d.table.more?.changed) return Promise.resolve(false);
  const offset = shown.rows.length;
  const rows = moreRows(offset, settings.dbPageRows);
  if (rows === 0) return Promise.resolve(false);
  patchTable(docId, { more: { running: true, error: null, changed: false } });
  return serial(laneOf(docId), async () => {
    const d = docs[docId];
    const conn = connOf(d);
    // Another read came first (a filter, a refresh): these are not the rows after its own.
    if (!d?.table || d.result?.outcome !== shown || !conn) {
      patchTable(docId, { more: null });
      return false;
    }
    const sql = pageSql(d.kind, d.table.ref, d.table.where, d.table.orderBy, offset, rows);
    const refusal = readRefusal(d.kind, sql, pageTail(offset, rows));
    if (refusal) {
      patchTable(docId, { more: null, refusal });
      return false;
    }
    patch(docId, { running: { statement: sql, since: Date.now() }, failure: null });
    let outcome: DbOutcome;
    try {
      outcome = await dbQuery(conn.id, sql, rows + 1, false);
    } catch (e) {
      // Said as the document's failure (or a refusal), as a read from the start says it.
      const f = lost(docId, e);
      patch(docId, f.kind === "readOnly" ? { running: null } : { running: null, failure: f });
      patchTable(docId, f.kind === "readOnly" ? { more: null, refusal: "notRead" } : { more: null });
      return false;
    }
    stands(docId, outcome);
    const now = docs[docId];
    if (!now?.table || !now.result || now.result.outcome !== shown) return false;
    if (outcome.error) {
      patch(docId, { running: null });
      patchTable(docId, { more: { running: false, error: outcome.error.message, changed: false } });
      return false;
    }
    const { outcome: page, hasNext } = pageOf(outcome, rows);
    const joined = appendPage(shown, page);
    if (!joined) {
      // The table changed between the reads: its rows are read again from the start, by the user's word.
      diag.info("db", "table columns changed between reads", { rows: offset });
      patch(docId, { running: null });
      patchTable(docId, { more: { running: false, error: null, changed: true } });
      return false;
    }
    patch(docId, {
      running: null,
      result: { ...now.result, outcome: joined, at: Date.now() },
      table: { ...now.table, hasNext, more: null },
    });
    return true;
  });
}

/** Count a table's rows exactly, with the filter shown: by the user's word, it is a whole pass. */
export function countTable(docId: string): Promise<void> {
  const d = docs[docId];
  if (!d?.table) return Promise.resolve();
  const where = d.table.where;
  const sql = countSql(d.kind, d.table.ref, where);
  if (readRefusal(d.kind, sql, countTail(d.kind, d.table.ref, where))) {
    patchTable(docId, { refusal: "open" });
    return Promise.resolve();
  }
  patchTable(docId, { count: { where, n: null, running: true, error: null } });
  return serial(laneOf(docId), async () => {
    patch(docId, { running: { statement: sql, since: Date.now() } });
    const out = await quiet(docId, sql, 1);
    const now = docs[docId];
    if (!now?.table) return;
    const n = out && !out.error ? Number(out.rows[0]?.[0]) : NaN;
    const ok = Number.isFinite(n);
    patch(docId, {
      running: null,
      table: { ...now.table, count: { where, n: ok ? n : null, running: false, error: ok ? null : (out?.error?.message ?? failureText({ kind: "closed" })) } },
    });
    if (ok && !where.trim()) counts = { ...counts, [`${catalogKey(now.place, now.dbId)}#${tableKey(now.table.ref)}`]: n };
  });
}

/** Count a table's rows on a browse connection (the tree's "Count rows"). */
export function countRows(browse: string, ref: TableRef): Promise<number | null> {
  const d = docs[browse];
  if (!d) return Promise.resolve(null);
  return serial(browse, async () => {
    const out = await quiet(browse, countSql(d.kind, ref, ""), 1);
    const n = out && !out.error ? Number(out.rows[0]?.[0]) : NaN;
    if (!Number.isFinite(n)) return null;
    counts = { ...counts, [`${catalogKey(d.place, d.dbId)}#${tableKey(ref)}`]: n };
    return n;
  });
}

/** Show a view of a table document; the structure and the DDL are read the first time they are shown. */
export function showTableTab(docId: string, tab: DbTableState["tab"]): void {
  patchTable(docId, { tab });
  const t = docs[docId]?.table;
  if (tab === "structure" && !t?.structure?.data) void loadStructure(docId);
  if (tab === "ddl" && !t?.ddl?.text) void loadDdl(docId);
}

/** Read a table's structure: its columns, indexes, foreign keys both ways, size and upkeep. */
async function readStructure(docId: string): Promise<TableStructure | null> {
  const d = docs[docId];
  if (!d?.table) return null;
  const q = structureQueries(d.kind, d.table.ref);
  const columns = await quiet(docId, q.columns, 2000);
  if (!columns || columns.error) {
    patchTable(docId, { structure: { data: null, loading: false, error: columns?.error?.message ?? failureText({ kind: "closed" }) } });
    return null;
  }
  const indexes = await quiet(docId, q.indexes, 500);
  const foreign = await quiet(docId, q.foreign, 2000);
  const size = await quiet(docId, q.size, 1);
  const fks = foreign && !foreign.error ? parseForeign(foreign, d.table.ref) : { foreign: [], incoming: [] };
  const data: TableStructure = {
    columns: parseStructColumns(columns),
    indexes: indexes && !indexes.error ? parseStructIndexes(indexes) : [],
    ...fks,
    size: size && !size.error ? parseSize(size) : null,
  };
  patchTable(docId, { structure: { data, loading: false, error: null } });
  return data;
}

export function loadStructure(docId: string): Promise<void> {
  patchTable(docId, { structure: { data: docs[docId]?.table?.structure?.data ?? null, loading: true, error: null } });
  return serial(laneOf(docId), async () => {
    await readStructure(docId);
  });
}

/** Read a table's DDL: MySQL's own; PostgreSQL's put together from its catalog, which the view says. */
export function loadDdl(docId: string): Promise<void> {
  const fail = (error: string) => patchTable(docId, { ddl: { text: null, how: "none", loading: false, error } });
  patchTable(docId, { ddl: { text: null, how: "none", loading: true, error: null } });
  return serial(laneOf(docId), async () => {
    const d = docs[docId];
    if (!d?.table) return;
    const { ref, tableKind } = d.table;
    const q = ddlQueries(d.kind, ref, tableKind);
    if (q.show) {
      const out = await quiet(docId, q.show, 1);
      const text = out && !out.error ? shownDdl(out) : null;
      if (text === null) return fail(out?.error?.message ?? failureText({ kind: "closed" }));
      patchTable(docId, { ddl: { text, how: "server", loading: false, error: null } });
      return;
    }
    if (q.view) {
      const out = await quiet(docId, q.view, 1);
      const def = out && !out.error ? (out.rows[0]?.[0] ?? null) : null;
      if (def === null) return fail(out?.error?.message ?? failureText({ kind: "closed" }));
      patchTable(docId, { ddl: { text: viewDdl(ref, tableKind, def), how: "assembled", loading: false, error: null } });
      return;
    }
    if (!q.constraints || !q.partition) {
      patchTable(docId, { ddl: { text: null, how: "none", loading: false, error: null } });
      return;
    }
    const structure = docs[docId]?.table?.structure?.data ?? (await readStructure(docId));
    if (!structure) return fail(docs[docId]?.table?.structure?.error ?? failureText({ kind: "closed" }));
    const constraints = await quiet(docId, q.constraints, 500);
    const partition = await quiet(docId, q.partition, 1);
    if (!constraints || constraints.error) return fail(constraints?.error?.message ?? failureText({ kind: "closed" }));
    const text = tableDdl(ref, structure.columns, constraints, partition && !partition.error ? (partition.rows[0]?.[0] ?? null) : null, structure.indexes);
    patchTable(docId, { ddl: { text, how: "assembled", loading: false, error: null } });
  });
}

/**
 * Read in full a value the backend cut at 64 KiB, by its row's primary key, in
 * parts small enough not to be cut again — up to `VALUE_MAX` characters.
 */
export function readFullValue(docId: string, row: number, col: number, keyColumns: readonly string[]): Promise<void> {
  const d = docs[docId];
  const o = d?.result?.outcome;
  if (!d?.table || !o) return Promise.resolve();
  const values = rowValues(o, row, keyColumns);
  const where = values && matchWhere(d.kind, keyColumns, values, d.backslashEscapes);
  if (!where) {
    patchTable(docId, { value: { row, col, text: null, loading: false, error: null, capped: false } });
    return Promise.resolve();
  }
  patchTable(docId, { value: { row, col, text: null, loading: true, error: null, capped: false } });
  const q = valueQueries(d.kind, d.table.ref, o.columns[col].name, where);
  return serial(laneOf(docId), async () => {
    const at = () => docs[docId]?.table?.value;
    const done = (text: string | null, error: string | null, capped = false) => {
      const v = at();
      if (v && v.row === row && v.col === col) patchTable(docId, { value: { row, col, text, loading: false, error, capped } });
    };
    const len = await quiet(docId, q.length, 1);
    const total = len && !len.error ? Number(len.rows[0]?.[0]) : NaN;
    if (!Number.isFinite(total)) return done(null, len?.error?.message ?? failureText({ kind: "closed" }));
    let text = "";
    for (let from = 1; from <= Math.min(total, VALUE_MAX); from += VALUE_CHUNK) {
      const v = at();
      if (!v || v.row !== row || v.col !== col) return;
      const part = await quiet(docId, q.part(from), 1);
      if (!part || part.error || part.cut.length > 0) return done(null, part?.error?.message ?? failureText({ kind: "closed" }));
      text += part.rows[0]?.[0] ?? "";
    }
    done(text, null, total > VALUE_MAX);
  });
}

/** The value panel moved to another cell: a value read in full is of the cell it was read for. */
export function forgetFullValue(docId: string): void {
  patchTable(docId, { value: null });
}

/** The primary key's columns of a table document's table, from the catalog. */
export function tablePrimary(docId: string): string[] {
  const d = docs[docId];
  if (!d?.table) return [];
  return keysOf(catalogs[catalogKey(d.place, d.dbId)]?.catalog ?? null, d.table.ref).primary;
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
    const keys = await quiet(docId, q.keys, CATALOG_MAX);
    if (!tables || tables.error) {
      putCatalog(key, { catalog: had?.catalog ?? null, loading: false, error: tables?.error?.message ?? failureText({ kind: "closed" }) });
      return;
    }
    putCatalog(key, {
      catalog: {
        tables: parseTables(d.kind, tables),
        routines: routines && !routines.error ? parseRoutines(routines) : [],
        columns: columns && !columns.error ? parseColumns(columns) : {},
        keys: keys && !keys.error ? parseKeys(keys) : {},
        current: current?.rows[0]?.[0] ?? null,
        cut: !!(tables.truncated || routines?.truncated || columns?.truncated || keys?.truncated),
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
  // A table document borrows its browse connection: what it runs there stops, the connection stays.
  const shared = connOf(d);
  if (d.via && d.running && shared) void dbCancel(shared.id).catch(writtenByCall);
  if (!d.via) queues.delete(docId);
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
  // A browse connection holds no work of the user's: the catalog it reads is read again.
  return Object.keys(docs).filter((id) => docs[id].sessionId === sessionId && docs[id].view !== "browse" && dbWork(id) !== null);
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
    if (d.conn && (d.view === "console" || d.view === "browse") && !catalogs[catalogKey(d.place, d.dbId)]) void loadCatalog(d.place, d.dbId, id);
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
