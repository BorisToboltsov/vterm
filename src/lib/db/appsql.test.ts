import { describe, expect, it } from "vitest";
import { activityQueries, cancelSql, MY_SESSIONS_PLAIN, terminateSql } from "./dbactivity";
import { catalogQueries, firstRowsSql, indexesSql, tableMetaSql } from "./dbcatalog";
import { explainSql } from "./dbplan";
import { countSql, ddlQueries, pageSql, structureQueries, valueQueries } from "./dbtable";
import type { DbKind } from "../types";

// The SQL vterm writes itself, as a file both sides read: here it is what the
// builders give, in db/sql.rs every `reads` passes a read-only connection with
// no question and every `changes` does not. A query of the app the backend
// would refuse breaks a panel on every prod server.
const orders = { schema: "app", name: "orders" };

function cases(kind: DbKind) {
  const versions = kind === "postgres" ? ["12.9", "16.6"] : ["8.4.3", "11.4.4-MariaDB"];
  const activity = versions.flatMap((v) => {
    const q = activityQueries(kind, v);
    return [q.sessions, q.locks, q.stats, q.status, q.replicas, q.statements].filter((x): x is string => x !== null);
  });
  const reads = [
    ...Object.values(catalogQueries(kind)),
    ...activity,
    ...(kind === "mysql" ? [MY_SESSIONS_PLAIN, "ANALYZE SELECT * FROM t", "EXPLAIN SELECT * FROM t"] : []),
    tableMetaSql(kind, kind === "postgres" ? "16384" : "shop.orders"),
    indexesSql(kind, "app", "orders"),
    firstRowsSql(kind, { schema: "app", name: "update" }),
    // A table document (ADR 0081): a page with a filter and a sort typed by hand, its count, its structure, its DDL, a long value.
    pageSql(kind, orders, "status = 'failed' -- why", kind === "postgres" ? '"created_at" DESC' : "`created_at` DESC", 400, 200),
    pageSql(kind, orders, "", "", 0, 200),
    countSql(kind, orders, ""),
    countSql(kind, orders, "total > 10"),
    ...Object.values(structureQueries(kind, orders)),
    ...Object.values(ddlQueries(kind, orders, "table")),
    ...Object.values(ddlQueries(kind, orders, "view")),
    valueQueries(kind, orders, "meta", kind === "postgres" ? `"id" = '7'` : "`id` = '7'").length,
    valueQueries(kind, orders, "meta", kind === "postgres" ? `"id" = '7'` : "`id` = '7'").part(16385),
    explainSql(kind, "SELECT * FROM t", false),
    explainSql(kind, "SELECT * FROM t", true),
  ];
  return { kind, reads: [...new Set(reads)], changes: [cancelSql(kind, "42"), terminateSql(kind, "42")] };
}

describe("the app's own SQL", () => {
  it("is the file the backend checks", async () => {
    const text = JSON.stringify([cases("postgres"), cases("mysql")], null, 2) + "\n";
    await expect(text).toMatchFileSnapshot("./appsql.cases.json");
  });
});
