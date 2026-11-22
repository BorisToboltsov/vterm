// An answer as a grid and as a file (ADR 0080): how wide each column starts,
// how a cell reads in one line, and the answer as CSV, JSON, Markdown or
// INSERT statements — of the rows shown, which the export says.

import type { DbColumn, DbKind, DbOutcome } from "../types";
import { quoteIdent, quoteLiteral, quoteTable } from "./dbquote";

/** Character width of a column at first: its name or its widest early value, within bounds. */
export function columnChars(o: DbOutcome, c: number, sample = 200): number {
  let w = o.columns[c]?.name.length ?? 4;
  const rows = Math.min(o.rows.length, sample);
  for (let r = 0; r < rows; r++) {
    const v = o.rows[r][c];
    w = Math.max(w, v === null ? 4 : Math.min(v.length, 60));
  }
  return Math.max(4, Math.min(w, 48));
}

/** A cell in one line: line breaks shown as `↵`, long values cut for the eye only. */
export function cellLine(v: string | null, max = 300): string {
  if (v === null) return "NULL";
  const one = v.replace(/\r?\n/g, "↵").replace(/\t/g, " ");
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export type ExportFormat = "csv" | "tsv" | "json" | "markdown" | "insert";

const csvCell = (v: string | null, sep: string): string =>
  v === null ? "" : /["\r\n]/.test(v) || v.includes(sep) ? `"${v.replaceAll('"', '""')}"` : v;

/** One row as a line of TSV — a value's own line break stays inside its quotes. */
export const rowLine = (row: readonly (string | null)[]): string => row.map((v) => csvCell(v, "\t")).join("\t");

/** An object's keys: an answer may name two columns alike. */
function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set(names);
  const seen = new Set<string>();
  return names.map((name) => {
    if (!seen.has(name)) {
      seen.add(name);
      return name;
    }
    let n = 2;
    while (taken.has(`${name}_${n}`)) n++;
    taken.add(`${name}_${n}`);
    return `${name}_${n}`;
  });
}

/** The rows shown, in a format; `table` names the INSERT's table. */
export function exportRows(o: DbOutcome, format: ExportFormat, kind: DbKind, table?: { schema: string | null; name: string }): string {
  const names = o.columns.map((c) => c.name);
  const keys = uniqueNames(names);
  switch (format) {
    case "csv":
    case "tsv": {
      const sep = format === "csv" ? "," : "\t";
      return [names, ...o.rows].map((row) => row.map((v) => csvCell(v, sep)).join(sep)).join("\n") + "\n";
    }
    case "json":
      return JSON.stringify(
        o.rows.map((row) => Object.fromEntries(row.map((v, i) => [keys[i], v]))),
        null,
        2,
      );
    case "markdown": {
      const esc = (v: string | null) => cellLine(v, 10_000).replaceAll("|", "\\|");
      const head = `| ${names.map((n) => esc(n)).join(" | ")} |`;
      const rule = `| ${o.columns.map((c) => (c.numeric ? "---:" : "---")).join(" | ")} |`;
      return [head, rule, ...o.rows.map((row) => `| ${row.map(esc).join(" | ")} |`)].join("\n") + "\n";
    }
    case "insert": {
      const target = quoteTable(table?.schema ?? null, table?.name ?? "t", kind);
      const cols = names.map((n) => quoteIdent(n, kind)).join(", ");
      return o.rows.map((row) => `INSERT INTO ${target} (${cols}) VALUES (${row.map((v) => quoteLiteral(v, kind, o.backslashEscapes)).join(", ")});`).join("\n") + "\n";
    }
  }
}

/** The file name an export suggests. */
export const exportName = (base: string, format: ExportFormat): string =>
  `${base.replace(/[^\w.-]+/g, "_") || "result"}.${format === "markdown" ? "md" : format === "insert" ? "sql" : format}`;

/** Whether a column's values compare as numbers. */
export const isNumeric = (c: DbColumn): boolean => c.numeric;
