// Editing an answer's rows (ADR 0080): only rows of one table whose primary
// key the answer holds — each change then says exactly which row it is about.
// A change is the cells set and the rows marked for deletion; the statements it
// becomes are shown before they run, and run in one transaction that checks
// each touched exactly one row (`db_apply`).

import type { DbKind, DbOutcome } from "../types";
import type { TableMeta } from "./dbcatalog";
import { quoteIdent, quoteLiteral, quoteTable } from "./dbquote";
import { nameParts, tokens } from "./sqlsplit";

/** Why the answer cannot be edited. */
export type NotEditable = "computed" | "manyTables" | "noKey" | "keyMissing" | "notRows" | "notRead" | "notPlain" | "notTable" | "inTx" | "metaFailed";

/** An answer that can be edited: its table, and each column's name in it (null — not its). */
export interface EditTarget {
  /** As the backend names it: PostgreSQL's oid, MySQL's `schema.table`. */
  table: string;
  meta: TableMeta;
  names: (string | null)[];
  /** Columns of the answer that make the key, in key order. */
  keyCols: number[];
}

/** The one table the answer's columns come from, or why there is none. */
export function sourceTable(o: DbOutcome): string | NotEditable {
  if (o.columns.length === 0 || o.error) return "notRows";
  const tables = new Set(o.columns.map((c) => c.table).filter((t): t is string => !!t));
  if (tables.size === 0) return "computed";
  if (tables.size > 1) return "manyTables";
  return [...tables][0];
}

/** Types shown as hex or otherwise not writable back as text. */
const NOT_TEXT = new Set(["BLOB", "BYTEA", "GEOMETRY", "BIT", "BINARY", "VARBINARY", "UNKNOWN"]);

/**
 * The one table a plain SELECT reads, as written. A join of a table with
 * itself, a union, a subquery among the columns: their rows' key values may be
 * another row's — null.
 */
export function plainTable(statement: string, kind: DbKind): string | null {
  const ts = tokens(statement, kind);
  const word = (i: number) => (ts[i]?.kind === "word" ? ts[i].text.toUpperCase() : "");
  const name = (i: number) => (ts[i] && (ts[i].kind === "word" || ts[i].kind === "quoted") ? ts[i].text : null);
  if (word(0) === "TABLE") return ts.length === 2 ? name(1) : null;
  if (word(0) !== "SELECT" || word(1) === "DISTINCT") return null;
  let from = -1;
  for (let i = 1; i < ts.length && from < 0; i++) {
    if (word(i) === "SELECT") return null;
    // `a IS DISTINCT FROM b` is a comparison.
    if (ts[i].depth === 0 && word(i) === "FROM" && word(i - 1) !== "DISTINCT") from = i;
  }
  if (from < 0) return null;
  const at = word(from + 1) === "ONLY" ? from + 2 : from + 1;
  if (ts[at + 1]?.text === "(") return null;
  let inFrom = true;
  for (let i = at + 1; i < ts.length; i++) {
    if (ts[i].depth !== 0) continue;
    const w = word(i);
    if (["JOIN", "STRAIGHT_JOIN", "UNION", "INTERSECT", "EXCEPT", "GROUP", "HAVING"].includes(w)) return null;
    if (["WHERE", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR", "WINDOW"].includes(w)) inFrom = false;
    if (inFrom && ts[i].text === ",") return null;
  }
  return name(at);
}

/** What can be edited, once the table's meta is known; `statement` — what gave the rows. */
export function editTarget(o: DbOutcome, table: string, meta: TableMeta | null, kind: DbKind, statement: string): EditTarget | NotEditable {
  if (!o.read) return "notRead";
  if (!meta) return "metaFailed";
  const from = plainTable(statement, kind);
  if (from === null || nameParts(from).pop()?.toLowerCase() !== meta.name.toLowerCase()) return "notPlain";
  // One column twice: two values would be set for one.
  const own = o.columns.filter((c) => c.table === table && c.column).map((c) => c.column);
  if (new Set(own).size !== own.length) return "notPlain";
  if (meta.key.length === 0) return "noKey";
  if (!meta.transactional) return "notTable";
  const names = o.columns.map((c) => (c.table === table && c.column ? (meta.columns[c.column] ?? null) : null));
  const keyCols = meta.key.map((k) => names.indexOf(k));
  if (keyCols.some((i) => i < 0 || NOT_TEXT.has(o.columns[i].typeName.toUpperCase()))) return "keyMissing";
  return { table, meta, names, keyCols };
}

/** Pending changes: cell values set (row → column → value) and rows to delete. */
export interface Edits {
  set: Record<number, Record<number, string | null>>;
  deleted: number[];
}

export const NO_EDITS: Edits = { set: {}, deleted: [] };

/** Whether a row can be told by its key: none of the key's values was cut. */
export function rowEditable(o: DbOutcome, t: EditTarget, row: number): boolean {
  return !o.cut.some(([r, c]) => r === row && t.keyCols.includes(c));
}

/** Whether a cell may be edited: its column is the table's, neither it nor its row's key was cut, it is not bytes shown as hex. */
export function cellEditable(o: DbOutcome, t: EditTarget, row: number, col: number): boolean {
  if (t.names[col] === null || !rowEditable(o, t, row)) return false;
  if (o.cut.some(([r, c]) => r === row && c === col)) return false;
  return !NOT_TEXT.has(o.columns[col].typeName.toUpperCase());
}

/** The edits with one cell set; set back to what it was — no change. */
export function setCell(e: Edits, o: DbOutcome, row: number, col: number, value: string | null): Edits {
  const rowSet = { ...(e.set[row] ?? {}) };
  if (value === o.rows[row][col]) delete rowSet[col];
  else rowSet[col] = value;
  const set = { ...e.set };
  if (Object.keys(rowSet).length) set[row] = rowSet;
  else delete set[row];
  return { ...e, set };
}

/** The edits with a row marked for deletion, or unmarked. */
export function toggleDelete(e: Edits, row: number): Edits {
  return e.deleted.includes(row) ? { ...e, deleted: e.deleted.filter((r) => r !== row) } : { ...e, deleted: [...e.deleted, row].sort((a, b) => a - b) };
}

export const editCount = (e: Edits): number => Object.keys(e.set).filter((r) => !e.deleted.includes(Number(r))).length + e.deleted.length;

/** The value a cell shows: its edit, else what the answer said. */
export function shownValue(e: Edits, o: DbOutcome, row: number, col: number): string | null {
  const set = e.set[row];
  return set && col in set ? set[col] : o.rows[row][col];
}

/**
 * The statements the edits become: one UPDATE per changed row, one DELETE per
 * deleted row, each finding its row by the key's values as the answer had them.
 */
export function editStatements(o: DbOutcome, t: EditTarget, e: Edits, kind: DbKind, backslashEscapes = kind === "mysql"): string[] {
  const table = quoteTable(t.meta.schema, t.meta.name, kind);
  const where = (row: number) =>
    t.keyCols
      .map((c) => {
        const v = o.rows[row][c];
        return `${quoteIdent(t.names[c] as string, kind)} ${v === null ? "IS NULL" : `= ${quoteLiteral(v, kind, backslashEscapes)}`}`;
      })
      .join(" AND ");
  const out: string[] = [];
  for (const [r, cols] of Object.entries(e.set)) {
    const row = Number(r);
    if (e.deleted.includes(row)) continue;
    const sets = Object.entries(cols)
      .map(([c, v]) => `${quoteIdent(t.names[Number(c)] as string, kind)} = ${quoteLiteral(v, kind, backslashEscapes)}`)
      .join(", ");
    out.push(`UPDATE ${table} SET ${sets} WHERE ${where(row)}`);
  }
  for (const row of e.deleted) out.push(`DELETE FROM ${table} WHERE ${where(row)}`);
  return out;
}
