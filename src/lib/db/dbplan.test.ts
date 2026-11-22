import { describe, expect, it } from "vitest";
import type { DbOutcome } from "../types";
import { explainSql, filterColumns, flatten, indexAdvice, myFilterColumns, parseMyPlan, parsePgPlan, share } from "./dbplan";
import pgJson from "./dbplan.pg.json?raw";
import myTree from "./dbplan.my.txt?raw";

const answer = (rows: (string | null)[][]): DbOutcome => ({
  columns: [{ name: "QUERY PLAN", typeName: "json", numeric: false, table: null, column: null, key: false }],
  rows,
  cut: [],
  truncated: false,
  affected: null,
  elapsedMs: 1,
  notices: [],
  error: null,
  read: true,
  tx: "none",
  backslashEscapes: false,
});

// Answers of the live stand (e2e/docker-compose.db.yml): PostgreSQL 16 with a
// parallel plan, MySQL 8.4's EXPLAIN ANALYZE — what the servers really print.

describe("PostgreSQL plans", () => {
  const plan = parsePgPlan(answer([[pgJson]]));

  it("reads the tree, its times and whether it ran", () => {
    expect(plan).not.toBeNull();
    expect(plan!.analyzed).toBe(true);
    expect(plan!.executionMs).toBeGreaterThan(0);
    const steps = flatten(plan!.root);
    expect(steps[0].node.label).toBe("Limit");
    expect(steps.map((s) => s.node.label)).toContain("Seq Scan · invoices");
    for (const { node } of steps) expect(node.selfMs).toBeGreaterThanOrEqual(0);
  });

  it("does not add up the times of parallel workers", () => {
    const steps = flatten(plan!.root);
    const gather = steps.find((s) => s.node.label === "Gather")!.node;
    // Under the Gather the workers ran at once: no step below lasts longer than it.
    for (const { node } of flatten(gather).slice(1)) expect(node.totalMs!).toBeLessThanOrEqual(gather.totalMs! + 0.001);
    for (const { node } of steps) expect(share(node, plan!.root)).toBeLessThanOrEqual(1);
  });

  it("points at a scan that throws most of the table away, with its filter's columns", () => {
    const scan = flatten(plan!.root).find((s) => s.node.warn?.kind === "seqScan")!.node;
    expect(scan.warn!.relation).toEqual({ schema: null, name: "invoices" });
    expect(scan.warn!.columns).toEqual(["status", "due_at"]);
    expect(scan.warn!.removed).toBeGreaterThan(10_000);
  });

  it("says nothing it cannot read", () => {
    expect(parsePgPlan(answer([["not json"]]))).toBeNull();
    expect(parsePgPlan(answer([]))).toBeNull();
  });
});

describe("MySQL plans", () => {
  it("reads the indented tree and its actual times", () => {
    const plan = parseMyPlan(answer(myTree.split("\n").map((l) => [l])))!;
    expect(plan.analyzed).toBe(true);
    const steps = flatten(plan.root);
    expect(steps[0].node.label).toBe("Limit: 100 row(s)");
    const scan = steps.find((s) => s.node.label === "Table scan on invoices")!;
    expect(scan.depth).toBe(5);
    expect(scan.node.actualRows).toBe(60000);
    expect(scan.node.warn).toMatchObject({ kind: "seqScan", relation: { name: "invoices" }, columns: ["status", "due_at"] });
  });

  it("reads a plan that did not run, by its estimates", () => {
    const plan = parseMyPlan(answer([["-> Filter: (invoices.`status` = 'unpaid')  (cost=5925 rows=5869)\n    -> Table scan on invoices  (cost=5925 rows=58690)"]]))!;
    expect(plan.analyzed).toBe(false);
    expect(plan.root.children[0].estRows).toBe(58690);
    expect(plan.root.children[0].warn?.kind).toBe("seqScan");
  });
});

describe("advice", () => {
  const warn = { kind: "seqScan" as const, relation: { schema: "public", name: "invoices" }, columns: ["status", "due_at"] };
  it("suggests an index only when none leads with the filter's column", () => {
    expect(indexAdvice("postgres", warn, [["id"]])).toEqual({ exists: false, ddl: 'CREATE INDEX CONCURRENTLY ON "public"."invoices" ("status", "due_at");' });
    expect(indexAdvice("postgres", warn, [["status"]])).toEqual({ exists: true, ddl: null });
    expect(indexAdvice("mysql", { ...warn, relation: { schema: null, name: "invoices" } }, null).ddl).toBe(
      "CREATE INDEX `ix_invoices_status_due_at` ON `invoices` (`status`, `due_at`);",
    );
  });

  it("reads filter columns of both servers", () => {
    expect(filterColumns("((a.\"x\" = 1) AND (y ~~ 'q%'::text) AND (z IS NULL))")).toEqual(["x", "y", "z"]);
    expect(myFilterColumns("((t.`a` = 'x') and (t.b like 'q%'))")).toEqual(["a", "b"]);
  });

  it("asks each server its own way, and runs a statement only when told to", () => {
    expect(explainSql("postgres", "select 1", false)).toBe("EXPLAIN (VERBOSE, FORMAT JSON) select 1");
    expect(explainSql("postgres", "select 1", true)).toBe("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) select 1");
    expect(explainSql("mysql", "select 1", false)).toBe("EXPLAIN FORMAT=TREE select 1");
    expect(explainSql("mysql", "select 1", true)).toBe("EXPLAIN ANALYZE select 1");
  });
});
