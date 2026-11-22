// Names and values in SQL the app writes itself (ADR 0080): a catalog query
// about one table, an edit's UPDATE, "first rows" of a table. A name is quoted
// the dialect's way, a value is a string literal with its quotes doubled — and
// in MySQL its backslashes too, unless the server reads them as plain
// characters (`NO_BACKSLASH_ESCAPES`).

import type { DbKind } from "../types";

/** A name, quoted: `"a""b"` in PostgreSQL, `` `a``b` `` in MySQL. */
export function quoteIdent(name: string, kind: DbKind): string {
  return kind === "postgres" ? `"${name.replaceAll('"', '""')}"` : `\`${name.replaceAll("`", "``")}\``;
}

/** `schema.table`, each part quoted. */
export function quoteTable(schema: string | null, table: string, kind: DbKind): string {
  return schema ? `${quoteIdent(schema, kind)}.${quoteIdent(table, kind)}` : quoteIdent(table, kind);
}

/**
 * A value as a string literal, or `NULL`. `backslashEscapes` — the server reads
 * `\` as an escape: MySQL's default; PostgreSQL only with
 * `standard_conforming_strings` off.
 */
export function quoteLiteral(value: string | null, kind: DbKind, backslashEscapes = kind === "mysql"): string {
  if (value === null) return "NULL";
  let v = value.replaceAll("'", "''");
  if (backslashEscapes) v = v.replaceAll("\\", "\\\\");
  if (v.includes("\0")) v = v.replaceAll("\0", backslashEscapes ? "\\0" : "");
  return `'${v}'`;
}
