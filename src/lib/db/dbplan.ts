// A query plan as a tree (ADR 0080): PostgreSQL's `EXPLAIN (FORMAT JSON)` and
// MySQL's `EXPLAIN FORMAT=TREE` read into one model — each step, its rows, its
// own time and share — and what in it deserves a look: a scan that reads a
// table to throw most of it away, an estimate far from what happened, a sort
// or a hash that went to disk. A suggestion is text for the editor; nothing
// here runs.

import type { DbKind, DbOutcome } from "../types";
import { quoteIdent, quoteTable } from "./dbquote";
import { nameParts, tokens } from "./sqlsplit";

export type PlanWarnKind = "seqScan" | "misestimate" | "sortDisk" | "hashDisk";

export interface PlanWarn {
  kind: PlanWarnKind;
  /** For a scan: its table and the columns its filter compares. */
  relation?: { schema: string | null; name: string };
  columns?: string[];
  removed?: number;
  estimate?: number;
  actual?: number;
}

export interface PlanNode {
  label: string;
  /** Its condition: filter, index or join condition, sort key. */
  detail: string;
  estRows: number | null;
  actualRows: number | null;
  loops: number;
  /** Time spent in it and below (ms, all loops); null — not run (no ANALYZE). */
  totalMs: number | null;
  /** Its own time: total less its children's. */
  selfMs: number | null;
  cost: number | null;
  children: PlanNode[];
  warn: PlanWarn | null;
}

export interface Plan {
  root: PlanNode;
  analyzed: boolean;
  planningMs: number | null;
  executionMs: number | null;
}

/** The statement that asks for a plan; `analyze` runs it (reads only). */
export function explainSql(kind: DbKind, statement: string, analyze: boolean): string {
  if (kind === "postgres") return `EXPLAIN (${analyze ? "ANALYZE, BUFFERS, " : ""}VERBOSE, FORMAT JSON) ${statement}`;
  return analyze ? `EXPLAIN ANALYZE ${statement}` : `EXPLAIN FORMAT=TREE ${statement}`;
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────

type PgNode = Record<string, unknown> & { Plans?: PgNode[] };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The columns a filter compares: `(status = 'x'::text) AND (due_at < now())` → status, due_at. */
export function filterColumns(filter: string): string[] {
  const out: string[] = [];
  const re = /\(\s*(?:\w+\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:=|<>|!=|<=|>=|<|>|~~\*?|!~~|IS\b|IN\b|= ANY)/g;
  for (const m of filter.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * One step. Under a Gather its workers run at once: their "Actual Total Time"
 * is each one's, not a sum — it is not multiplied by the loops.
 */
function pgNode(n: PgNode, parallel = false): PlanNode {
  const type = str(n["Node Type"]);
  const concurrent = parallel || n["Parallel Aware"] === true;
  const rel = str(n["Relation Name"]);
  const index = str(n["Index Name"]);
  const label = [type, rel && `· ${rel}`, index && `(${index})`].filter(Boolean).join(" ");
  const detail = [n["Index Cond"], n["Hash Cond"], n["Merge Cond"], n["Join Filter"], n["Filter"], n["Recheck Cond"]]
    .map(str)
    .filter(Boolean)
    .concat(Array.isArray(n["Sort Key"]) ? [`${(n["Sort Key"] as string[]).join(", ")}`] : [])
    .concat(Array.isArray(n["Group Key"]) ? [`${(n["Group Key"] as string[]).join(", ")}`] : [])
    .join(" · ");
  const loops = num(n["Actual Loops"]) ?? 1;
  const actualTotal = num(n["Actual Total Time"]);
  const children = (n.Plans ?? []).map((c) => pgNode(c, concurrent || type.startsWith("Gather")));
  const totalMs = actualTotal === null ? null : concurrent ? actualTotal : actualTotal * loops;
  const childMs = children.reduce((s, c) => s + (c.totalMs ?? 0), 0);
  const actualRows = num(n["Actual Rows"]);
  const estRows = num(n["Plan Rows"]);
  const node: PlanNode = {
    label,
    detail,
    estRows,
    actualRows: actualRows === null ? null : actualRows * loops,
    loops,
    totalMs,
    selfMs: totalMs === null ? null : Math.max(0, totalMs - childMs),
    cost: num(n["Total Cost"]),
    children,
    warn: null,
  };
  const removed = num(n["Rows Removed by Filter"]);
  if (type === "Seq Scan" && rel && removed !== null && removed >= 10_000 && removed >= 10 * Math.max(1, node.actualRows ?? 0)) {
    node.warn = { kind: "seqScan", relation: { schema: str(n["Schema"]) || null, name: rel }, columns: filterColumns(str(n["Filter"])), removed };
  } else if (str(n["Sort Method"]).includes("external")) {
    node.warn = { kind: "sortDisk" };
  } else if ((num(n["Hash Batches"]) ?? 1) > 1) {
    node.warn = { kind: "hashDisk" };
  } else if (estRows !== null && node.actualRows !== null && Math.max(estRows, node.actualRows) >= 1000) {
    const ratio = Math.max(estRows, 1) / Math.max(node.actualRows, 1);
    if (ratio >= 100 || ratio <= 0.01) node.warn = { kind: "misestimate", estimate: estRows, actual: node.actualRows };
  }
  return node;
}

/** PostgreSQL's JSON plan: the one cell `EXPLAIN (FORMAT JSON)` answers. */
export function parsePgPlan(o: DbOutcome): Plan | null {
  const text = o.rows[0]?.[0];
  if (!text) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const top = Array.isArray(doc) ? (doc[0] as Record<string, unknown>) : null;
  const plan = top?.Plan as PgNode | undefined;
  if (!plan) return null;
  const root = pgNode(plan);
  return {
    root,
    analyzed: root.totalMs !== null,
    planningMs: num(top?.["Planning Time"]),
    executionMs: num(top?.["Execution Time"]),
  };
}

// ── MySQL ─────────────────────────────────────────────────────────────────────

/** MySQL's tree: `-> Step  (cost=… rows=…) (actual time=a..b rows=r loops=l)`, four spaces a level. */
export function parseMyPlan(o: DbOutcome): Plan | null {
  const text = o.rows.map((r) => r[0] ?? "").join("\n");
  const lines = text.split("\n").filter((l) => l.trim().startsWith("->"));
  if (lines.length === 0) return null;
  const stack: { depth: number; node: PlanNode }[] = [];
  let root: PlanNode | null = null;
  let analyzed = false;
  for (const line of lines) {
    const depth = line.indexOf("->") / 4;
    const body = line.trim().slice(2).trim();
    const cut = body.search(/\s+\((cost=|actual time=|rows=)/);
    const label = (cut < 0 ? body : body.slice(0, cut)).trim();
    const cost = /cost=([\d.e+]+)/.exec(body);
    const est = /cost=[\d.e+]+ rows=([\d.e+]+)/.exec(body) ?? /^[^(]*\(rows=([\d.e+]+)/.exec(body);
    const actual = /actual time=[\d.]+\.\.([\d.]+) rows=([\d.e+]+) loops=(\d+)/.exec(body);
    if (actual) analyzed = true;
    const loops = actual ? Number(actual[3]) : 1;
    const node: PlanNode = {
      label,
      detail: "",
      estRows: est ? Number(est[1]) : null,
      actualRows: actual ? Number(actual[2]) * loops : null,
      loops,
      totalMs: actual ? Number(actual[1]) * loops : null,
      selfMs: null,
      cost: cost ? Number(cost[1]) : null,
      children: [],
      warn: null,
    };
    // A filter or a scan reads its condition from its label.
    const filter = /^Filter: (.*)$/.exec(label);
    if (filter) node.detail = filter[1];
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else root ??= node;
    stack.push({ depth, node });
  }
  if (!root) return null;
  const finish = (n: PlanNode, parentFilter: string) => {
    for (const c of n.children) finish(c, n.detail || parentFilter);
    const childMs = n.children.reduce((s, c) => s + (c.totalMs ?? 0), 0);
    n.selfMs = n.totalMs === null ? null : Math.max(0, n.totalMs - childMs);
    const scan = /^Table scan on (\S+)/.exec(n.label);
    const rows = n.actualRows ?? n.estRows ?? 0;
    if (scan && rows >= 10_000 && parentFilter) {
      n.warn = { kind: "seqScan", relation: { schema: null, name: scan[1].replace(/`/g, "") }, columns: myFilterColumns(parentFilter) };
    }
  };
  finish(root, "");
  return { root, analyzed, planningMs: null, executionMs: analyzed ? root.totalMs : null };
}

/** The columns a MySQL filter compares: `(t.status = 'x') and (t.due_at < now())`. */
export function myFilterColumns(filter: string): string[] {
  const out: string[] = [];
  const re = /\(\s*(?:`?\w+`?\.)?`?([A-Za-z_][A-Za-z0-9_]*)`?\s*(?:=|<>|!=|<=|>=|<|>|like\b|is\b|in\b)/gi;
  for (const m of filter.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function parsePlan(kind: DbKind, o: DbOutcome): Plan | null {
  return kind === "postgres" ? parsePgPlan(o) : parseMyPlan(o);
}

/**
 * MySQL's tree names a table by the statement's alias: the table behind each,
 * or an index would be suggested for a table that is not there.
 */
export function resolveAliases(plan: Plan, statement: string): void {
  const ts = tokens(statement, "mysql");
  const tables = new Map<string, { schema: string | null; name: string } | null>();
  const note = (as: string, of: { schema: string | null; name: string }) => {
    const had = tables.get(as);
    // One alias in two places of the statement is nobody's.
    tables.set(as, tables.has(as) && (had?.name !== of.name || had?.schema !== of.schema) ? null : of);
  };
  const clause = /^(WHERE|JOIN|INNER|LEFT|RIGHT|CROSS|NATURAL|STRAIGHT_JOIN|ON|USING|GROUP|ORDER|LIMIT|HAVING|SET|UNION|FOR|LOCK|WINDOW|USE|FORCE|IGNORE|PARTITION|WITH|VALUES)$/i;
  let inFrom = false;
  for (let i = 0; i < ts.length; i++) {
    const w = ts[i].kind === "word" ? ts[i].text.toUpperCase() : "";
    if (w === "FROM") inFrom = true;
    else if (["WHERE", "GROUP", "ORDER", "SET", "SELECT", "HAVING"].includes(w)) inFrom = false;
    const starts = ["FROM", "JOIN", "STRAIGHT_JOIN", "UPDATE"].includes(w) || (inFrom && ts[i].text === ",");
    const t = ts[i + 1];
    if (!starts || !t || (t.kind !== "word" && t.kind !== "quoted")) continue;
    const parts = nameParts(t.text);
    const name = parts.pop();
    if (!name) continue;
    const of = { schema: parts.pop() ?? null, name };
    let a = i + 2;
    if (ts[a]?.text.toUpperCase() === "AS") a++;
    const alias = ts[a];
    const named = alias && (alias.kind === "quoted" || (alias.kind === "word" && !clause.test(alias.text))) ? nameParts(alias.text)[0] : name;
    note(named, of);
  }
  for (const { node } of flatten(plan.root)) {
    if (node.warn?.kind !== "seqScan" || !node.warn.relation) continue;
    // Not a table of the statement (a derived one, a CTE): no advice about it.
    node.warn.relation = tables.get(node.warn.relation.name) ?? undefined;
  }
}

// ── Reading it ────────────────────────────────────────────────────────────────

/** The plan's steps in order, each with its depth — the way the view lists them. */
export function flatten(root: PlanNode): { node: PlanNode; depth: number }[] {
  const out: { node: PlanNode; depth: number }[] = [];
  const walk = (n: PlanNode, depth: number) => {
    out.push({ node: n, depth });
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** A step's share of the whole: its own time over the root's, else its cost over the root's. */
export function share(n: PlanNode, root: PlanNode): number {
  if (n.selfMs !== null && root.totalMs) return Math.min(1, n.selfMs / root.totalMs);
  if (n.cost !== null && root.cost) return Math.min(1, n.cost / root.cost);
  return 0;
}

/**
 * What a scan's warning suggests, against the table's indexes as they are:
 * an index that leads with the filter's first column is there — the planner
 * did not take it (statistics, a type, a function on the column); none is —
 * here is one to consider, as text.
 */
export function indexAdvice(
  kind: DbKind,
  warn: PlanWarn,
  indexes: string[][] | null,
): { exists: boolean; ddl: string | null } {
  const cols = warn.columns ?? [];
  if (!warn.relation || cols.length === 0) return { exists: false, ddl: null };
  const exists = !!indexes?.some((ix) => ix[0] === cols[0]);
  if (exists) return { exists, ddl: null };
  const target = quoteTable(warn.relation.schema, warn.relation.name, kind);
  const list = cols.map((c) => quoteIdent(c, kind)).join(", ");
  // MySQL wants an index named; PostgreSQL names it, and builds it without locking writes.
  const ddl =
    kind === "postgres"
      ? `CREATE INDEX CONCURRENTLY ON ${target} (${list});`
      : `CREATE INDEX ${quoteIdent(`ix_${warn.relation.name}_${cols.join("_")}`.slice(0, 64), kind)} ON ${target} (${list});`;
  return { exists, ddl };
}
