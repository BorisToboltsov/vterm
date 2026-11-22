import { describe, expect, it } from "vitest";
import { activityQueries, cancelSql, MY_SESSIONS_PLAIN, terminateSql } from "./dbactivity";
import { catalogQueries, firstRowsSql, indexesSql, tableMetaSql } from "./dbcatalog";
import { explainSql } from "./dbplan";
import type { DbKind } from "../types";

// The SQL vterm writes itself, as a file both sides read: here it is what the
// builders give, in db/sql.rs every `reads` passes a read-only connection with
// no question and every `changes` does not. A query of the app the backend
// would refuse breaks a panel on every prod server.
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
