// A table of a database as a document (ADR 0081): its rows read on as the list
// is scrolled to its end, filtered and sorted by the server, its structure and its DDL — the SQL built
// here, run by the backend on the database's browse connection. The document
// only reads: what it builds from the user's WHERE and ORDER BY is checked to
// be one read before it runs (`readRefusal`); a change goes through the edits,
// as in the console.

import type { DbKind, DbOutcome } from "../types";
import type { Catalog, ForeignKey, TableKeys, TableKind } from "./dbcatalog";
import { quoteIdent, quoteLiteral, quoteTable } from "./dbquote";
import { classify } from "./sqlclass";
import { splitSql, tokens } from "./sqlsplit";

export interface TableRef {
  schema: string;
  name: string;
}

export const tableKey = (t: TableRef): string => `${t.schema}.${t.name}`;

export type SortDir = "ASC" | "DESC";

/** A sort a header click wrote. */
export interface Sort {
  column: string;
  dir: SortDir;
}

/** The ORDER BY a header click writes: the column quoted, its direction. */
export const orderByOf = (s: Sort, kind: DbKind): string => `${quoteIdent(s.column, kind)} ${s.dir}`;

/** The sort an ORDER BY text is when a header wrote it; anything typed by hand is not one (null). */
export function sortOf(orderBy: string, kind: DbKind): Sort | null {
  const q = kind === "postgres" ? '"' : "`";
  const m = orderBy.trim().match(kind === "postgres" ? /^"((?:[^"]|"")+)"\s+(ASC|DESC)$/i : /^`((?:[^`]|``)+)`\s+(ASC|DESC)$/i);
  return m ? { column: m[1].replaceAll(q + q, q), dir: m[2].toUpperCase() as SortDir } : null;
}

/** A header clicked: ascending, then descending, then no sort. */
export function nextSort(current: Sort | null, column: string): Sort | null {
  if (!current || current.column !== column) return { column, dir: "ASC" };
  return current.dir === "ASC" ? { column, dir: "DESC" } : null;
}

/**
 * The user's WHERE in the statement: in brackets and on its own line, so a
 * trailing `--` comment or an `OR` cannot reach what follows it.
 */
const whereOf = (where: string): string => (where.trim() ? ` WHERE (${where.trim()}\n)` : "");
const orderOf = (orderBy: string): string => (orderBy.trim() ? ` ORDER BY ${orderBy.trim()}\n` : "");

/**
 * The rows of a table from `offset`: a row more than asked, so the answer says
 * whether there are more (`pageOf`) — or, for the console (`probe` false), the
 * rows as they are. The sort is the server's: sorting the rows read so far
 * would show an order the table does not have.
 */
export function pageSql(kind: DbKind, t: TableRef, where: string, orderBy: string, offset: number, rows: number, probe = true): string {
  return `SELECT * FROM ${quoteTable(t.schema, t.name, kind)}${whereOf(where)}${orderOf(orderBy)} LIMIT ${probe ? rows + 1 : rows} OFFSET ${Math.max(0, offset)}`;
}

/** The exact count, with the filter shown — a whole pass over a big table, run only when asked. */
export function countSql(kind: DbKind, t: TableRef, where: string): string {
  return `SELECT count(*) FROM ${quoteTable(t.schema, t.name, kind)}${whereOf(where)}`;
}

/** Why a statement the document built must not run (null — it may): it is one read, and the user's text closed. */
export type ReadRefusal = "many" | "notRead" | "open";

/**
 * A statement of the document runs only when it is one statement that reads,
 * and the text the user typed into it closed every bracket, string and comment
 * it opened: the statement must still end with what the document put last.
 */
export function readRefusal(kind: DbKind, statement: string, tail: readonly string[]): ReadRefusal | null {
  if (splitSql(statement, kind).length !== 1) return "many";
  const c = classify(statement, kind);
  if (c.cls !== "read" || c.confirm !== null) return "notRead";
  const ts = tokens(statement, kind);
  const end = ts.slice(-tail.length);
  if (end.length !== tail.length || end.some((tok, i) => tok.depth !== 0 || tok.text.toUpperCase() !== tail[i].toUpperCase())) return "open";
  return null;
}

/** What a statement of rows ends with. */
export const pageTail = (offset: number, rows: number): string[] => ["LIMIT", String(rows + 1), "OFFSET", String(Math.max(0, offset))];

/** What a count ends with: the bracket the document closed the filter with, or the table. */
export const countTail = (kind: DbKind, t: TableRef, where: string): string[] => (where.trim() ? [")"] : [quoteTable(t.schema, t.name, kind)]);

/**
 * Rows as shown: the extra row says there are more and is dropped. The backend
 * stopping at its own cap before the extra row says the same.
 */
export function pageOf(o: DbOutcome, rows: number): { outcome: DbOutcome; hasNext: boolean } {
  if (o.error) return { outcome: o, hasNext: false };
  const hasNext = o.rows.length > rows || o.truncated;
  if (!hasNext) return { outcome: o, hasNext };
  return { outcome: { ...o, rows: o.rows.slice(0, rows), cut: o.cut.filter(([r]) => r < rows), truncated: false }, hasNext };
}

/**
 * The most rows a table document holds: one answer of the backend (`MAX_ROWS`
 * in db/mod.rs). Past it the user narrows the rows with a filter.
 */
export const TABLE_ROWS_MAX = 10_000;

/** How many rows to read after `loaded`: the page, never past the cap; 0 — the cap is reached. */
export const moreRows = (loaded: number, page: number): number => Math.max(0, Math.min(page, TABLE_ROWS_MAX - loaded));

/** How many rows a read again from the start asks for: as many as are shown, so the list stays where it was. */
export const rereadRows = (loaded: number, page: number): number => Math.min(TABLE_ROWS_MAX, Math.max(page, loaded));

/**
 * The rows read on, after those shown: their row numbers — of the cut cells
 * too — follow the rows before, so edits and the selection stay on their rows.
 * The columns stay the shown ones (the grid knows the answer by them). Other
 * columns than before — the table changed between the reads — are not more of
 * the same rows: null.
 */
export function appendPage(shown: DbOutcome, more: DbOutcome): DbOutcome | null {
  const same =
    shown.columns.length === more.columns.length && shown.columns.every((c, i) => c.name === more.columns[i].name && c.typeName === more.columns[i].typeName);
  if (!same) return null;
  const n = shown.rows.length;
  return {
    ...shown,
    rows: [...shown.rows, ...more.rows],
    cut: [...shown.cut, ...more.cut.map(([r, c]): [number, number] => [r + n, c])],
    notices: [...shown.notices, ...more.notices],
    elapsedMs: shown.elapsedMs + more.elapsedMs,
    tx: more.tx,
    backslashEscapes: more.backslashEscapes,
  };
}

// ── Keys and links ────────────────────────────────────────────────────────────

const NO_KEYS: TableKeys = { primary: [], foreign: [] };

export const keysOf = (cat: Catalog | null, t: TableRef): TableKeys => cat?.keys?.[tableKey(t)] ?? NO_KEYS;

/** A foreign key pointing at a table, and the table it is of. */
export interface Incoming {
  from: TableRef;
  fk: ForeignKey;
}

/** The foreign keys of other tables (and of itself) that point at a table. */
export function incomingOf(cat: Catalog | null, t: TableRef): Incoming[] {
  const out: Incoming[] = [];
  for (const [key, keys] of Object.entries(cat?.keys ?? {})) {
    const dot = key.indexOf(".");
    for (const fk of keys.foreign) {
      if (fk.ref.schema === t.schema && fk.ref.name === t.name) out.push({ from: { schema: key.slice(0, dot), name: key.slice(dot + 1) }, fk });
    }
  }
  return out.sort((a, b) => tableKey(a.from).localeCompare(tableKey(b.from)) || a.fk.name.localeCompare(b.fk.name));
}

/** The foreign key a column of the answer belongs to (the first, when it is in several). */
export function fkOfColumn(keys: TableKeys, column: string): ForeignKey | null {
  return keys.foreign.find((fk) => fk.columns.includes(column)) ?? null;
}

/** `a = '1' AND b = '2'` over `names`, with `values` in the same order; null — a value is NULL: it points nowhere. */
export function matchWhere(kind: DbKind, names: readonly string[], values: readonly (string | null)[], backslashEscapes = kind === "mysql"): string | null {
  if (names.length === 0 || names.length !== values.length || values.some((v) => v === null)) return null;
  return names.map((n, i) => `${quoteIdent(n, kind)} = ${quoteLiteral(values[i], kind, backslashEscapes)}`).join(" AND ");
}

/** A row's values of some columns of the answer, by name; null — the answer does not hold one of them. */
export function rowValues(o: DbOutcome, row: number, names: readonly string[]): (string | null)[] | null {
  const at = names.map((n) => o.columns.findIndex((c) => c.name === n));
  if (at.some((i) => i < 0) || !o.rows[row]) return null;
  return at.map((i) => o.rows[row][i]);
}

/** Where a foreign key of a row leads: the table it points at, filtered to the row it names. */
export function followFk(kind: DbKind, o: DbOutcome, row: number, fk: ForeignKey, backslashEscapes?: boolean): { table: TableRef; where: string } | null {
  const values = rowValues(o, row, fk.columns);
  const where = values && matchWhere(kind, fk.refColumns, values, backslashEscapes);
  return where ? { table: { ...fk.ref }, where } : null;
}

/** The rows of another table that point at a row: its foreign key's columns equal the row's. */
export function followIncoming(kind: DbKind, o: DbOutcome, row: number, inc: Incoming, backslashEscapes?: boolean): { table: TableRef; where: string } | null {
  const values = rowValues(o, row, inc.fk.refColumns);
  const where = values && matchWhere(kind, inc.fk.columns, values, backslashEscapes);
  return where ? { table: { ...inc.from }, where } : null;
}

// ── Structure ─────────────────────────────────────────────────────────────────

export interface StructColumn {
  name: string;
  type: string;
  nullable: boolean;
  /** As the server prints it; null — none. */
  default: string | null;
  comment: string | null;
  /** PostgreSQL: identity ("always"/"byDefault") or a stored generated column; MySQL: its EXTRA as is. */
  identity: "always" | "byDefault" | null;
  generated: boolean;
  extra: string | null;
}

export interface StructIndex {
  name: string;
  /** PostgreSQL's whole definition (the DDL takes it as is); null on MySQL. */
  def: string | null;
  /** What it covers, as shown: `(id)`, `btree (created_at DESC)`. */
  columns: string;
  unique: boolean;
  primary: boolean;
  /** It is a constraint's own index: the DDL writes the constraint, not the index. */
  ofConstraint: boolean;
  bytes: number | null;
}

/** A foreign key with what deleting the row it points at does. */
export interface StructFk extends ForeignKey {
  from: TableRef;
  onDelete: string | null;
}

export interface StructSize {
  data: number | null;
  indexes: number | null;
  toast: number | null;
  total: number | null;
  /** The planner's estimate of rows (PostgreSQL) or InnoDB's. */
  estimate: number | null;
  live: number | null;
  dead: number | null;
  /** Seconds since the last ANALYZE / VACUUM, manual or automatic; null — never, or not this server's. */
  analyzedAgo: number | null;
  vacuumedAgo: number | null;
  /** MySQL: the space allocated and unused; the engine. */
  free: number | null;
  engine: string | null;
}

export interface TableStructure {
  columns: StructColumn[];
  indexes: StructIndex[];
  /** Its own foreign keys. */
  foreign: StructFk[];
  /** Foreign keys of other tables pointing at it. */
  incoming: StructFk[];
  size: StructSize | null;
}

/** A table as a PostgreSQL `regclass` literal. */
const regclass = (t: TableRef): string => `${quoteLiteral(quoteTable(t.schema, t.name, "postgres"), "postgres")}::regclass`;

/** The queries of the Structure view, each one read; their answers go to `parseStructure`. */
export function structureQueries(kind: DbKind, t: TableRef): { columns: string; indexes: string; foreign: string; size: string } {
  if (kind === "postgres") {
    const x = regclass(t);
    return {
      columns: `SELECT a.attnum::text, a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN '0' ELSE '1' END, pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), a.attidentity::text, a.attgenerated::text FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = ${x} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      indexes: `SELECT c.relname, pg_get_indexdef(i.indexrelid), CASE WHEN i.indisunique THEN '1' ELSE '0' END, CASE WHEN i.indisprimary THEN '1' ELSE '0' END, pg_relation_size(i.indexrelid), CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid) THEN '1' ELSE '0' END, NULL, NULL FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = ${x} ORDER BY i.indisprimary DESC, c.relname`,
      foreign: `SELECT k.conname, u.i::text, cn.nspname, c.relname, a.attname, fn.nspname, fc.relname, fa.attname, k.confdeltype::text FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS u(src, dst, i) JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.src JOIN pg_class fc ON fc.oid = k.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace JOIN pg_attribute fa ON fa.attrelid = k.confrelid AND fa.attnum = u.dst WHERE k.contype = 'f' AND (k.conrelid = ${x} OR k.confrelid = ${x}) ORDER BY cn.nspname, c.relname, k.conname, u.i`,
      size: `SELECT pg_relation_size(c.oid), pg_indexes_size(c.oid), CASE WHEN c.reltoastrelid = 0 THEN NULL ELSE pg_total_relation_size(c.reltoastrelid) END, pg_total_relation_size(c.oid), c.reltuples::bigint, s.n_live_tup, s.n_dead_tup, EXTRACT(EPOCH FROM (now() - greatest(s.last_analyze, s.last_autoanalyze)))::bigint, EXTRACT(EPOCH FROM (now() - greatest(s.last_vacuum, s.last_autovacuum)))::bigint, NULL, NULL FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid WHERE c.oid = ${x}`,
    };
  }
  const schema = quoteLiteral(t.schema, kind);
  const name = quoteLiteral(t.name, kind);
  return {
    columns: `SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, CASE WHEN IS_NULLABLE = 'YES' THEN '1' ELSE '0' END, COLUMN_DEFAULT, COLUMN_COMMENT, '', EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${schema} AND TABLE_NAME = ${name} ORDER BY ORDINAL_POSITION`,
    indexes: `SELECT INDEX_NAME, NULL, CASE WHEN MIN(NON_UNIQUE) = 0 THEN '1' ELSE '0' END, CASE WHEN INDEX_NAME = 'PRIMARY' THEN '1' ELSE '0' END, NULL, '0', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX), INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${schema} AND TABLE_NAME = ${name} GROUP BY INDEX_NAME, INDEX_TYPE ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME`,
    foreign: `SELECT k.CONSTRAINT_NAME, k.ORDINAL_POSITION, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.REFERENCED_TABLE_NAME IS NOT NULL AND ((k.TABLE_SCHEMA = ${schema} AND k.TABLE_NAME = ${name}) OR (k.REFERENCED_TABLE_SCHEMA = ${schema} AND k.REFERENCED_TABLE_NAME = ${name})) ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    size: `SELECT DATA_LENGTH, INDEX_LENGTH, NULL, DATA_LENGTH + INDEX_LENGTH, TABLE_ROWS, NULL, NULL, NULL, NULL, DATA_FREE, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${schema} AND TABLE_NAME = ${name}`,
  };
}

const cell = (o: DbOutcome, r: number, c: number): string | null => o.rows[r]?.[c] ?? null;
const num = (v: string | null): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** PostgreSQL's `confdeltype` as words; MySQL already says them. */
const PG_DELETE: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

export function parseColumns(o: DbOutcome): StructColumn[] {
  return o.rows.map((_, r) => {
    const identity = cell(o, r, 6);
    const extra = cell(o, r, 7);
    return {
      name: cell(o, r, 1) ?? "",
      type: cell(o, r, 2) ?? "",
      nullable: cell(o, r, 3) === "1",
      default: cell(o, r, 4),
      comment: cell(o, r, 5) || null,
      identity: identity === "a" ? "always" : identity === "d" ? "byDefault" : null,
      // PostgreSQL says `s`; MySQL's EXTRA says what it is in words.
      generated: extra === "s",
      extra: extra && extra.length > 1 ? extra : null,
    };
  });
}

/** What an index covers, from PostgreSQL's definition: what follows `USING`. */
export function indexCovers(def: string): string {
  const at = def.search(/\sUSING\s/i);
  return at < 0 ? def : def.slice(at).trim().replace(/^USING\s+/i, "");
}

export function parseIndexes(o: DbOutcome): StructIndex[] {
  return o.rows.map((_, r) => {
    const def = cell(o, r, 1);
    const cols = cell(o, r, 6);
    const method = cell(o, r, 7);
    return {
      name: cell(o, r, 0) ?? "",
      def,
      columns: def ? indexCovers(def) : `${method ? `${method.toLowerCase()} ` : ""}(${cols ?? ""})`,
      unique: cell(o, r, 2) === "1",
      primary: cell(o, r, 3) === "1",
      ofConstraint: cell(o, r, 5) === "1",
      bytes: num(cell(o, r, 4)),
    };
  });
}

/** Foreign keys of and to a table, a row per column pair, grouped back into keys. */
export function parseForeign(o: DbOutcome, t: TableRef): { foreign: StructFk[]; incoming: StructFk[] } {
  const keys = new Map<string, StructFk>();
  for (let r = 0; r < o.rows.length; r++) {
    const from = { schema: cell(o, r, 2) ?? "", name: cell(o, r, 3) ?? "" };
    const id = `${tableKey(from)}\u0000${cell(o, r, 0)}`;
    let fk = keys.get(id);
    if (!fk) {
      const rule = cell(o, r, 8) ?? "";
      fk = { name: cell(o, r, 0) ?? "", from, columns: [], ref: { schema: cell(o, r, 5) ?? "", name: cell(o, r, 6) ?? "" }, refColumns: [], onDelete: PG_DELETE[rule] ?? (rule || null) };
      keys.set(id, fk);
    }
    fk.columns.push(cell(o, r, 4) ?? "");
    fk.refColumns.push(cell(o, r, 7) ?? "");
  }
  const all = [...keys.values()];
  const own = (k: StructFk) => k.from.schema === t.schema && k.from.name === t.name;
  // A key of a table to itself is both: its own, and pointing at it.
  return { foreign: all.filter(own), incoming: all.filter((k) => k.ref.schema === t.schema && k.ref.name === t.name) };
}

export function parseSize(o: DbOutcome): StructSize | null {
  if (o.rows.length === 0) return null;
  const n = (c: number) => num(cell(o, 0, c));
  const estimate = n(4);
  return {
    data: n(0),
    indexes: n(1),
    toast: n(2),
    total: n(3),
    // PostgreSQL 14+ says -1 for a table never vacuumed or analyzed.
    estimate: estimate !== null && estimate >= 0 ? estimate : null,
    live: n(5),
    dead: n(6),
    analyzedAgo: n(7),
    vacuumedAgo: n(8),
    free: n(9),
    engine: cell(o, 0, 10),
  };
}

/** Dead rows as a share of all, in %: null — not counted (MySQL, a table never analyzed). */
export function deadShare(s: StructSize): number | null {
  if (s.live === null || s.dead === null || s.live + s.dead === 0) return null;
  return Math.round((1000 * s.dead) / (s.live + s.dead)) / 10;
}

// ── DDL ───────────────────────────────────────────────────────────────────────

/**
 * How a table's DDL is had: MySQL says it (`SHOW CREATE TABLE`); PostgreSQL has
 * no such statement, so it is put together from the catalog's own printers —
 * and says what it leaves out. A foreign table's server options are not read:
 * no DDL for it.
 */
export function ddlQueries(kind: DbKind, t: TableRef, tableKind: TableKind): { show?: string; constraints?: string; partition?: string; view?: string } {
  if (kind === "mysql") return { show: `SHOW CREATE TABLE ${quoteTable(t.schema, t.name, kind)}` };
  const x = regclass(t);
  if (tableKind === "view" || tableKind === "matview") return { view: `SELECT pg_get_viewdef(${x}, true)` };
  if (tableKind === "foreign") return {};
  return {
    constraints: `SELECT conname, pg_get_constraintdef(oid, true), contype::text FROM pg_constraint WHERE conrelid = ${x} AND contype IN ('p', 'u', 'c', 'f', 'x') ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname`,
    partition: `SELECT pg_get_partkeydef(${x})`,
  };
}

/** MySQL's own text of the table (or view): the answer's second column. */
export const shownDdl = (o: DbOutcome): string | null => (o.rows[0]?.[1] ?? null);

/** A PostgreSQL view's DDL around the server's own definition. */
export function viewDdl(t: TableRef, tableKind: TableKind, def: string): string {
  const what = tableKind === "matview" ? "MATERIALIZED VIEW" : "VIEW";
  return `CREATE ${what} ${quoteTable(t.schema, t.name, "postgres")} AS\n${def.trim().replace(/;\s*$/, "")};\n`;
}

/** A PostgreSQL table's DDL from its columns, constraints, partition key and indexes. */
export function tableDdl(t: TableRef, columns: readonly StructColumn[], constraints: DbOutcome, partition: string | null, indexes: readonly StructIndex[]): string {
  const lines = columns.map((c) => {
    let line = `  ${quoteIdent(c.name, "postgres")} ${c.type}`;
    if (c.identity) line += ` GENERATED ${c.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
    else if (c.generated && c.default !== null) line += ` GENERATED ALWAYS AS (${c.default}) STORED`;
    if (!c.nullable) line += " NOT NULL";
    if (!c.identity && !c.generated && c.default !== null) line += ` DEFAULT ${c.default}`;
    return line;
  });
  for (let r = 0; r < constraints.rows.length; r++) {
    const name = constraints.rows[r][0];
    const def = constraints.rows[r][1];
    if (name !== null && def !== null) lines.push(`  CONSTRAINT ${quoteIdent(name, "postgres")} ${def}`);
  }
  let out = `CREATE TABLE ${quoteTable(t.schema, t.name, "postgres")} (\n${lines.join(",\n")}\n)`;
  if (partition) out += ` PARTITION BY ${partition}`;
  out += ";\n";
  for (const ix of indexes) if (!ix.ofConstraint && ix.def) out += `${ix.def};\n`;
  return out;
}

// ── A cell's value ────────────────────────────────────────────────────────────

/**
 * JSON laid out with indents, its text kept as it was: a number is not read
 * into a JS number (it would lose digits), a string keeps its escapes. Null —
 * the text is not an object or an array.
 */
export function indentJson(text: string, step = "  "): string | null {
  const s = text.trim();
  if (!/^[[{]/.test(s)) return null;
  // Whether it is JSON at all; what the parse made of it is not used.
  try {
    JSON.parse(s);
  } catch {
    return null;
  }
  let out = "";
  let depth = 0;
  let inString = false;
  const nl = () => `\n${step.repeat(depth)}`;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === "\\") out += s[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === close) {
        out += c + close;
        i = j;
        continue;
      }
      depth++;
      out += c + nl();
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth < 0) return null;
      out += nl() + c;
    } else if (c === ",") out += c + nl();
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
  }
  return depth === 0 && !inString ? out : null;
}

/** How the value panel shows a value: JSON laid out, anything else as it is. */
export function shownValue(v: string | null, typeName: string): { text: string; json: boolean } | null {
  if (v === null) return null;
  if (/json/i.test(typeName) || /^\s*[[{]/.test(v)) {
    const laid = indentJson(v);
    if (laid !== null) return { text: laid, json: true };
  }
  return { text: v, json: false };
}

/** Characters of a long value read at a time: four bytes each at most, under the backend's 64 KiB cut. */
export const VALUE_CHUNK = 16_384;
/** The most of a value the panel reads: past it, it says so. */
export const VALUE_MAX = 1_048_576;

/** Types whose long value is read in parts as text; bytes are not. */
export const textual = (typeName: string): boolean => !/^(BLOB|BYTEA|GEOMETRY|BIT|BINARY|VARBINARY|LONGBLOB|MEDIUMBLOB|TINYBLOB|UNKNOWN)$/i.test(typeName);

/** A long value's length, and a part of it from `from` (1-based), of the row the key names. */
export function valueQueries(kind: DbKind, t: TableRef, column: string, keyWhere: string): { length: string; part: (from: number) => string } {
  const table = quoteTable(t.schema, t.name, kind);
  const col = quoteIdent(column, kind);
  const text = kind === "postgres" ? `${col}::text` : `CAST(${col} AS CHAR)`;
  const len = kind === "postgres" ? `length(${text})` : `CHAR_LENGTH(${text})`;
  return {
    length: `SELECT ${len} FROM ${table} WHERE ${keyWhere}`,
    part: (from) => `SELECT ${kind === "postgres" ? "substr" : "SUBSTRING"}(${text}, ${from}, ${VALUE_CHUNK}) FROM ${table} WHERE ${keyWhere}`,
  };
}

// ── Where the browse connection lives ─────────────────────────────────────────

/**
 * The tab whose session the tree reads a database through: one that already
 * has its browse connection, else the tab in focus, else the first ready one.
 */
export function pickSession(ready: readonly string[], active: string | null, has: (sessionId: string) => boolean): string | null {
  return ready.find(has) ?? (active !== null && ready.includes(active) ? active : null) ?? ready[0] ?? null;
}

// ── How numbers read ──────────────────────────────────────────────────────────

/** A size in bytes: B, KiB, MiB, GiB — a small table's index is not "0 MiB". */
export function sizeText(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(1)} GiB`;
}

/** A row count in a few characters: 950, 48 k, 1.2 M; empty — never counted. */
export function rowsText(n: number | null): string {
  if (n === null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1000) return `${Math.round(n / 1000)} k`;
  return String(n);
}
