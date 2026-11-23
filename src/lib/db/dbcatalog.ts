// What a database holds (ADR 0080): schemas, tables, views, routines and
// columns, read with the app's own catalog queries and parsed into one model —
// the panel's tree, the console's completion and its "first rows". The SQL is
// built here (INVARIANTS principle 2); the backend only runs it.

import type { DbKind, DbOutcome } from "../types";
import { quoteIdent, quoteLiteral, quoteTable } from "./dbquote";

export type TableKind = "table" | "view" | "matview" | "foreign" | "partitioned";

export interface CatTable {
  schema: string;
  name: string;
  kind: TableKind;
  /** The planner's estimate (PostgreSQL) or InnoDB's (MySQL); null — never counted. */
  rows: number | null;
}

export interface CatRoutine {
  schema: string;
  name: string;
  args: string;
  kind: "function" | "procedure";
}

export interface CatColumn {
  name: string;
  type: string;
  /** The column takes NULL; null — the server did not say. */
  nullable: boolean | null;
}

/** A foreign key: its columns and the columns of the table they point at, in order. */
export interface ForeignKey {
  name: string;
  columns: string[];
  ref: { schema: string; name: string };
  refColumns: string[];
}

/** A table's primary key and its foreign keys (ADR 0081). */
export interface TableKeys {
  primary: string[];
  foreign: ForeignKey[];
}

export interface Catalog {
  tables: CatTable[];
  routines: CatRoutine[];
  /** By `schema.table`. */
  columns: Record<string, CatColumn[]>;
  /** Primary and foreign keys by `schema.table` (ADR 0081): the tree's marks, the grid's links. */
  keys: Record<string, TableKeys>;
  /** The schema a bare name means: `current_schema()` / the current database. */
  current: string | null;
  /** A list was longer than is read: the tree and the completion say so. */
  cut?: boolean;
}

/** The most of each list that is read; one more is asked for, to know of more. */
export const CATALOG_MAX = 10_000;

const PG_HIDDEN = "('pg_catalog', 'information_schema')";
const MY_HIDDEN = "('mysql', 'information_schema', 'performance_schema', 'sys')";

/** The catalog's queries, run one by one on a connection. */
export function catalogQueries(kind: DbKind): { current: string; tables: string; routines: string; columns: string; keys: string } {
  if (kind === "postgres")
    return {
      current: "SELECT current_schema()",
      tables: `SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ${PG_HIDDEN} AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' AND NOT c.relispartition ORDER BY 1, 2 LIMIT ${CATALOG_MAX + 1}`,
      routines: `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ${PG_HIDDEN} AND p.prokind IN ('f', 'p') ORDER BY 1, 2 LIMIT ${CATALOG_MAX + 1}`,
      columns: `SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ${PG_HIDDEN} ORDER BY table_schema, table_name, ordinal_position LIMIT ${CATALOG_MAX + 1}`,
      // One row a column of a key: the constraint's name keeps a key of several columns together.
      keys: `SELECT n.nspname, c.relname, k.contype::text, a.attname, coalesce(fn.nspname, ''), coalesce(fc.relname, ''), coalesce(fa.attname, ''), k.conname FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS u(attnum, i) JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum LEFT JOIN pg_class fc ON fc.oid = k.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace LEFT JOIN pg_attribute fa ON fa.attrelid = k.confrelid AND fa.attnum = k.confkey[u.i::int] WHERE k.contype IN ('p', 'f') AND n.nspname NOT IN ${PG_HIDDEN} ORDER BY 1, 2, k.conname, u.i LIMIT ${CATALOG_MAX + 1}`,
    };
  return {
    current: "SELECT DATABASE()",
    tables: `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ${MY_HIDDEN} ORDER BY 1, 2 LIMIT ${CATALOG_MAX + 1}`,
    routines: `SELECT ROUTINE_SCHEMA, ROUTINE_NAME, '', ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ${MY_HIDDEN} ORDER BY 1, 2 LIMIT ${CATALOG_MAX + 1}`,
    columns: `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA NOT IN ${MY_HIDDEN} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT ${CATALOG_MAX + 1}`,
    keys: `SELECT TABLE_SCHEMA, TABLE_NAME, CASE WHEN CONSTRAINT_NAME = 'PRIMARY' THEN 'p' ELSE 'f' END, COLUMN_NAME, coalesce(REFERENCED_TABLE_SCHEMA, ''), coalesce(REFERENCED_TABLE_NAME, ''), coalesce(REFERENCED_COLUMN_NAME, ''), CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA NOT IN ${MY_HIDDEN} AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL) ORDER BY 1, 2, CONSTRAINT_NAME, ORDINAL_POSITION LIMIT ${CATALOG_MAX + 1}`,
  };
}

const cell = (o: DbOutcome, r: number, c: number): string => o.rows[r]?.[c] ?? "";

function tableKind(kind: DbKind, raw: string): TableKind {
  if (kind === "postgres") return ({ r: "table", p: "partitioned", v: "view", m: "matview", f: "foreign" } as const)[raw as "r"] ?? "table";
  return /VIEW/i.test(raw) ? "view" : "table";
}

export function parseTables(kind: DbKind, o: DbOutcome): CatTable[] {
  return o.rows.map((_, r) => {
    const n = Number(cell(o, r, 3));
    return {
      schema: cell(o, r, 0),
      name: cell(o, r, 1),
      kind: tableKind(kind, cell(o, r, 2)),
      rows: o.rows[r][3] === null || !Number.isFinite(n) || n < 0 ? null : n,
    };
  });
}

export function parseRoutines(o: DbOutcome): CatRoutine[] {
  return o.rows.map((_, r) => ({
    schema: cell(o, r, 0),
    name: cell(o, r, 1),
    args: cell(o, r, 2),
    kind: /^(p|PROCEDURE)$/.test(cell(o, r, 3)) ? "procedure" : "function",
  }));
}

export function parseColumns(o: DbOutcome): Record<string, CatColumn[]> {
  const out: Record<string, CatColumn[]> = {};
  for (let r = 0; r < o.rows.length; r++) {
    const key = `${cell(o, r, 0)}.${cell(o, r, 1)}`;
    const nullable = o.rows[r][4];
    (out[key] ??= []).push({ name: cell(o, r, 2), type: cell(o, r, 3), nullable: nullable === null || nullable === undefined ? null : nullable.toUpperCase() === "YES" });
  }
  return out;
}

/** Keys by `schema.table`; a foreign key's columns in the order the key has them. */
export function parseKeys(o: DbOutcome): Record<string, TableKeys> {
  const out: Record<string, TableKeys> = {};
  const fks = new Map<string, ForeignKey>();
  for (let r = 0; r < o.rows.length; r++) {
    const key = `${cell(o, r, 0)}.${cell(o, r, 1)}`;
    const keys = (out[key] ??= { primary: [], foreign: [] });
    if (cell(o, r, 2) === "p") {
      keys.primary.push(cell(o, r, 3));
      continue;
    }
    const id = `${key}\u0000${cell(o, r, 7)}`;
    let fk = fks.get(id);
    if (!fk) {
      fk = { name: cell(o, r, 7), columns: [], ref: { schema: cell(o, r, 4), name: cell(o, r, 5) }, refColumns: [] };
      fks.set(id, fk);
      keys.foreign.push(fk);
    }
    fk.columns.push(cell(o, r, 3));
    fk.refColumns.push(cell(o, r, 6));
  }
  return out;
}

/** The schemas a catalog shows, in order: the current one first. */
export function schemasOf(cat: Catalog): string[] {
  const all = [...new Set([...cat.tables.map((t) => t.schema), ...cat.routines.map((r) => r.schema)])].sort();
  return cat.current && all.includes(cat.current) ? [cat.current, ...all.filter((s) => s !== cat.current)] : all;
}

/**
 * Names for the editor's completion (`@codemirror/lang-sql`'s `schema`):
 * `schema → table → columns`, and the current schema's tables bare as well.
 */
export function completionNames(cat: Catalog): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const t of cat.tables) {
    (out[t.schema] ??= {})[t.name] = (cat.columns[`${t.schema}.${t.name}`] ?? []).map((c) => c.name);
  }
  return out;
}

/** "First rows" of a table: what double-click opens. */
export function firstRowsSql(kind: DbKind, t: Pick<CatTable, "schema" | "name">, rows = 100): string {
  return `SELECT * FROM ${quoteTable(t.schema, t.name, kind)} LIMIT ${rows}`;
}

/**
 * What an edit needs to know of the table its rows come from: its name, its
 * columns by the number the answer gave (PostgreSQL), its primary key.
 */
export interface TableMeta {
  schema: string;
  name: string;
  /** PostgreSQL attnum → column name; MySQL — name → name. */
  columns: Record<string, string>;
  /** The primary key's columns, by name, in order; empty — it has none. */
  key: string[];
  /**
   * Edits of it can be rolled back and name one row: InnoDB; in PostgreSQL —
   * not a parent of inherited tables, whose children repeat its keys.
   */
  transactional: boolean;
}

/** The query for a table's meta: by oid (PostgreSQL), by `schema.table` (MySQL). */
export function tableMetaSql(kind: DbKind, table: string): string {
  if (kind === "postgres") {
    const oid = /^\d+$/.test(table) ? table : "0";
    return `SELECT n.nspname, c.relname, a.attnum::text, a.attname, COALESCE((SELECT k.n FROM pg_index i, unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, n) WHERE i.indrelid = c.oid AND i.indisprimary AND k.attnum = a.attnum AND k.n <= i.indnkeyatts), 0)::text, CASE WHEN c.relkind = 'p' OR (c.relkind = 'r' AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhparent = c.oid)) THEN '1' ELSE '0' END FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE c.oid = ${oid} ORDER BY a.attnum`;
  }
  const dot = table.indexOf(".");
  const schema = table.slice(0, dot);
  const name = table.slice(dot + 1);
  return `SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_NAME, COALESCE((SELECT k.ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY'), 0), COALESCE((SELECT CASE WHEN e.ENGINE = 'InnoDB' THEN 1 ELSE 0 END FROM information_schema.TABLES e WHERE e.TABLE_SCHEMA = c.TABLE_SCHEMA AND e.TABLE_NAME = c.TABLE_NAME), 0) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = ${quoteLiteral(schema, kind)} AND c.TABLE_NAME = ${quoteLiteral(name, kind)} ORDER BY c.ORDINAL_POSITION`;
}

export function parseTableMeta(o: DbOutcome): TableMeta | null {
  if (o.rows.length === 0) return null;
  const columns: Record<string, string> = {};
  const key: { pos: number; name: string }[] = [];
  for (let r = 0; r < o.rows.length; r++) {
    columns[cell(o, r, 2)] = cell(o, r, 3);
    const pos = Number(cell(o, r, 4));
    if (pos > 0) key.push({ pos, name: cell(o, r, 3) });
  }
  return {
    schema: cell(o, 0, 0),
    name: cell(o, 0, 1),
    columns,
    key: key.sort((a, b) => a.pos - b.pos).map((k) => k.name),
    transactional: cell(o, 0, 5) === "1",
  };
}

/** The indexes of a table as each one's columns, leading first. */
export function indexesSql(kind: DbKind, schema: string, table: string): string {
  return kind === "postgres"
    ? `SELECT indexrelid::regclass::text, (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) FROM pg_index i WHERE i.indrelid = ${quoteLiteral(`${quoteIdent(schema, kind)}.${quoteIdent(table, kind)}`, kind)}::regclass`
    : `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${quoteLiteral(schema, kind)} AND TABLE_NAME = ${quoteLiteral(table, kind)} GROUP BY INDEX_NAME`;
}

/** Each index's columns, leading first. */
export function parseIndexes(o: DbOutcome): string[][] {
  return o.rows.map((_, r) => cell(o, r, 1).split(",").filter(Boolean));
}
