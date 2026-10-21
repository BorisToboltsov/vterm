// Utilities → access check: the rows of the rules table (v1.21, ADR 0032). A row
// is four cells of text — sources, targets, ports, protocol — plus the server
// picked by hand, if any. Pure (INVARIANTS "чистая логика в .ts"): the component
// only binds these to inputs.
//
// A row never has its own idea of a valid rule: it is written as one canonical
// line and handed to `parseRules`, so a rule the parser would reject can't get
// through the table.

import { parseRules, type NetRule, type ParseError, type Proto } from "./netcheck";
import { recognize, type RuleDraft } from "./netcheckpaste";

/** One row of the rules table. */
export interface RuleRow extends RuleDraft {
  id: string;
  /** Host key the row is checked from, picked by hand; null = by its source. */
  via: string | null;
}

/** Why a row can't run: an empty cell, or what the parser said. */
export type RowError = { code: "noTarget" | "noPorts" } | ParseError;

let seq = 0;

/** A row for the table, with a fresh id. */
export function newRow(draft: Partial<RuleDraft> = {}, via: string | null = null): RuleRow {
  seq += 1;
  return {
    id: `r${Date.now().toString(36)}-${seq}`,
    source: draft.source ?? "",
    targets: draft.targets ?? "",
    ports: draft.ports ?? "",
    proto: draft.proto ?? "tcp",
    via,
  };
}

/** Whether nothing was typed into the row yet. */
export function isBlankRow(row: RuleDraft): boolean {
  return !row.source.trim() && !row.targets.trim() && !row.ports.trim();
}

/** Ports as the rule syntax writes them: one bare, several in brackets. */
function portsPart(raw: string): string {
  const toks = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return toks.length === 1 ? toks[0] : `[${toks.join(", ")}]`;
}

/** The row as one canonical rule line: `src -> targets:[ports]/tcp`. */
export function rowLine(row: RuleDraft): string {
  const src = row.source.trim();
  const body = `${row.targets.trim()}:${portsPart(row.ports)}/${row.proto}`;
  return src ? `${src} -> ${body}` : body;
}

/** The row's rules (one per source), or why it has none. */
export function rowRules(row: RuleDraft): { rules: NetRule[]; error: RowError | null } {
  if (!row.targets.trim()) return { rules: [], error: { code: "noTarget" } };
  if (!row.ports.trim()) return { rules: [], error: { code: "noPorts" } };
  const { rules, errors } = parseRules(rowLine(row));
  return errors.length ? { rules: [], error: errors[0] } : { rules, error: null };
}

/** The rows as canonical lines, one per row — history, the audit, the report. */
export function rowsText(rows: readonly RuleDraft[]): string {
  return rows
    .filter((r) => !isBlankRow(r))
    .map(rowLine)
    .join("\n");
}

/** Rows back from text: a history entry, a paste — anything `recognize` reads. */
export function textRows(text: string): RuleRow[] {
  return recognize(text).rules.map((d) => newRow(d));
}

/**
 * A pasted/typed `host:ports` in the targets cell — split it across the two
 * cells. Null when there's no port part (then the text stays as typed).
 */
export function splitHostPort(raw: string): { target: string; ports: string } | null {
  const m = /^\s*([^\s:[\]]+)\s*:\s*\[?([\w\s,;-]+?)\]?\s*$/.exec(raw);
  if (!m || !/\d|^[a-z]/i.test(m[2])) return null;
  return { target: m[1], ports: m[2].trim() };
}

/** The protocol cell's value, whatever the select sent. */
export function asProto(v: string): Proto {
  return v === "udp" ? "udp" : "tcp";
}
