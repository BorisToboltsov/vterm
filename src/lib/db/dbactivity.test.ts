import { describe, expect, it } from "vitest";
import type { DbOutcome } from "../types";
import {
  activityQueries,
  blockingTree,
  cancelSql,
  dbProblems,
  DEFAULT_DB_THRESHOLDS,
  isMariaDb,
  parseReplicas,
  parseSessions,
  parseStats,
  parseStatements,
  pgMajor,
  terminateSql,
  type Activity,
  type DbSession,
} from "./dbactivity";

const answer = (rows: (string | null)[][], names: string[] = []): DbOutcome => ({
  columns: names.map((name) => ({ name, typeName: "text", numeric: false, table: null, column: null, key: false })),
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

const pgRow = (pid: string, state: string, xact: string | null, query: string | null, blockedBy: string, q = "select 1") =>
  [pid, "app", "psql", "10.0.0.5", "billing", state, "", xact, query, query, blockedBy, q];

describe("sessions", () => {
  it("reads PostgreSQL's states and who blocks whom", () => {
    const s = parseSessions(
      "postgres",
      answer([pgRow("4412", "idle in transaction", "372", "372", ""), pgRow("5120", "active", "41", "41", "4412"), pgRow("5133", "active", "38", "38", "5120")]),
      null,
    );
    expect(s.map((x) => x.state)).toEqual(["idleTx", "active", "active"]);
    expect(s[1].blockedBy).toEqual(["4412"]);
    const tree = blockingTree(s);
    expect(tree.map((n) => [n.session.id, n.depth])).toEqual([
      ["4412", 0],
      ["5120", 1],
      ["5133", 2],
    ]);
  });

  it("reads MySQL's commands, its open transactions and its lock waits", () => {
    const s = parseSessions(
      "mysql",
      answer([
        ["11", "app", "", "10.0.0.5:5000", "billing", "Sleep", "", "300", "300", "300", "", ""],
        ["12", "app", "", "10.0.0.6:5001", "billing", "Query", "updating", "20", "20", "20", "", "UPDATE t SET a = 1"],
        ["13", "app", "", "10.0.0.7:5002", "billing", "Sleep", "", null, "5", "5", "", ""],
      ]),
      answer([["12", "11"]]),
    );
    expect(s.map((x) => x.state)).toEqual(["idleTx", "active", "idle"]);
    expect(s[1].blockedBy).toEqual(["11"]);
  });

  it("lists a cycle of waits flat rather than lose it", () => {
    const base = parseSessions("postgres", answer([pgRow("1", "active", "1", "1", "2"), pgRow("2", "active", "1", "1", "1")]), null);
    expect(blockingTree(base).map((n) => n.session.id).sort()).toEqual(["1", "2"]);
  });
});

describe("problems", () => {
  const session = (over: Partial<DbSession>): DbSession => ({
    id: "1",
    user: "u",
    app: "",
    client: "",
    db: "",
    state: "active",
    wait: "",
    xactS: null,
    queryS: null,
    stateS: null,
    blockedBy: [],
    query: "",
    ...over,
  });
  const base: Activity = { conns: 10, maxConns: 100, hitPct: 99.5, replica: false, replayLagS: null, replicas: [], sessions: [], statements: [] };

  it("names what crosses its threshold, worst first", () => {
    const a: Activity = {
      ...base,
      conns: 90,
      hitPct: 80,
      replicas: [{ name: "replica-2", client: "", state: "streaming", lagS: 12 }],
      sessions: [session({ id: "4412", state: "idleTx", xactS: 372 }), session({ id: "5120", blockedBy: ["4412"], queryS: 41 })],
    };
    const p = dbProblems(a, DEFAULT_DB_THRESHOLDS);
    expect(p[0]).toMatchObject({ kind: "idleTx", level: "bad", waiting: 1 });
    expect(p.map((x) => x.kind).sort()).toEqual(["cacheHit", "conns", "idleTx", "lockWait", "replLag"]);
  });

  it("says nothing of a quiet database", () => {
    expect(dbProblems({ ...base, sessions: [session({ state: "idle", stateS: 9999 })] }, DEFAULT_DB_THRESHOLDS)).toEqual([]);
  });
});

describe("stats, replicas, statements", () => {
  it("reads PostgreSQL's stats row", () => {
    expect(parseStats(answer([["87", "200", "99.2", "t", "3"]]), null)).toEqual({ conns: 87, maxConns: 200, hitPct: 99.2, replica: true, replayLagS: 3 });
  });

  it("works out MySQL's buffer pool hits from its counters", () => {
    const status = answer([
      ["Innodb_buffer_pool_read_requests", "1000"],
      ["Innodb_buffer_pool_reads", "36"],
    ]);
    expect(parseStats(answer([["5", "151", null, null, null]]), status).hitPct).toBe(96.4);
  });

  it("reads where a replica stands", () => {
    expect(parseReplicas("postgres", answer([["replica-2", "10.0.0.9", "streaming", "12.0"]])).replicas[0].lagS).toBe(12);
    expect(parseReplicas("mysql", answer([["x", "17"]], ["Replica_IO_State", "Seconds_Behind_Source"]))).toEqual({ replicas: [], lagS: 17, isReplica: true });
    expect(parseReplicas("mysql", answer([])).isReplica).toBe(false);
  });

  it("reads the costliest statements", () => {
    expect(parseStatements(answer([["SELECT …", "18000", "84.1", "1512.3", "41.2"]]))[0]).toEqual({ query: "SELECT …", calls: 18000, meanMs: 84.1, totalS: 1512.3, share: 41.2 });
  });
});

describe("queries", () => {
  it("follow the server: PostgreSQL 13 renamed the timings, MariaDB keeps lock waits elsewhere", () => {
    expect(activityQueries("postgres", "16.4 (Debian)").statements).toContain("total_exec_time");
    expect(activityQueries("postgres", "12.9").statements).toContain("total_time");
    expect(activityQueries("mysql", "11.4.2-MariaDB").locks).toContain("INNODB_LOCK_WAITS");
    expect(activityQueries("mysql", "8.4.3").locks).toContain("data_lock_waits");
    expect(pgMajor("16.4")).toBe(16);
    expect(isMariaDb("11.4.2-MariaDB-ubu2404")).toBe(true);
  });

  it("stop or end a session by its number only", () => {
    expect(cancelSql("postgres", "42")).toBe("SELECT pg_cancel_backend(42)");
    expect(terminateSql("mysql", "42")).toBe("KILL 42");
    expect(cancelSql("mysql", "1; DROP TABLE t")).toBe("KILL QUERY 0");
  });
});
