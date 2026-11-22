import { describe, expect, it } from "vitest";
import type { DbOutcome, ServerProfile } from "../types";
import { remapServers } from "../servers/backupimport";
import { activityQueries, parseSessions, stopReached } from "./dbactivity";
import { applyFailureText } from "./dberror";
import { exportRows, rowLine } from "./dbgrid";
import { resolveAliases, type Plan, type PlanNode } from "./dbplan";
import { isThisComputer, newProfile, profileFromContainer, profileIssue } from "./dbprofile";
import { classify, writes } from "./sqlclass";
import { nameParts, offsetOfChar, splitSql } from "./sqlsplit";

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

describe("what the window asks about before a run", () => {
  it("is also a change dressed as something else", () => {
    for (const sql of ["BEGIN READ WRITE", "SELECT set_config('a.b', 'c', false)", "SELECT \"pg_terminate_backend\"(4)", "SET autocommit = 0"])
      expect(writes(classify(sql, "postgres")), sql).toBe(true);
    for (const sql of ["START REPLICA", "SELECT 1 /*! INTO OUTFILE '/tmp/x' */"]) expect(writes(classify(sql, "mysql")), sql).toBe(true);
    expect(classify("START TRANSACTION", "mysql").cls).toBe("tx");
  });

  it("reads comments the way the server does", () => {
    expect(splitSql("SELECT 1 -- x\r; DELETE FROM t", "postgres")).toHaveLength(2);
    expect(splitSql("/*!50000 SET NAMES utf8mb4 */;", "mysql")).toHaveLength(1);
  });
});

describe("names and places in a statement", () => {
  it("reads a written name as its parts", () => {
    expect(nameParts('public."Or.der"')).toEqual(["public", "Or.der"]);
    expect(nameParts("`shop`.`a``b`")).toEqual(["shop", "a`b"]);
  });

  it("counts the server's characters, not UTF-16 units", () => {
    expect(offsetOfChar("'🙂' x", 5)).toBe(5);
    expect(offsetOfChar("abc", 2)).toBe(1);
    expect(offsetOfChar("ab", 99)).toBe(2);
  });
});

describe("an answer taken out", () => {
  it("keeps columns named alike, line breaks and the server's escapes", () => {
    const o = answer([["1", "2"]], ["id", "id"]);
    expect(JSON.parse(exportRows(o, "json", "postgres"))[0]).toEqual({ id: "1", id_2: "2" });
    expect(rowLine(["a\nb", null, "c"])).toBe('"a\nb"\t\tc');
    expect(exportRows(answer([["a\\b"]], ["p"]), "insert", "mysql")).toContain("'a\\b'");
  });
});

describe("a profile", () => {
  it("of this computer is at this computer alone", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "/var/run/postgresql"]) expect(isThisComputer(h), h).toBe(true);
    for (const h of ["10.0.0.5", "0.0.0.0", "127.0.0.1.example.com", "db"]) expect(isThisComputer(h), h).toBe(false);
    expect(profileIssue({ ...newProfile("postgres", "p"), host: "10.0.0.5" }, true)).toBe("notLocal");
    expect(profileIssue({ ...newProfile("postgres", "p"), host: "10.0.0.5" })).toBeNull();
    expect(profileIssue({ ...newProfile("mysql", "p"), database: "--init-command=x" })).toBe("name");
    expect(profileIssue({ ...newProfile("mysql", "p"), container: "--privileged" })).toBe("container");
  });

  it("of a container goes where its port is published", () => {
    const seen = { name: "pg", image: "postgres:16", ip: "172.17.0.2", published: { 5432: 15432 }, env: {} };
    expect(profileFromContainer({ ...seen, bound: { 5432: "0.0.0.0" } }, "p")?.host).toBe("127.0.0.1");
    expect(profileFromContainer({ ...seen, bound: { 5432: "::" } }, "p")?.host).toBe("127.0.0.1");
    expect(profileFromContainer({ ...seen, bound: { 5432: "10.1.1.4" } }, "p")?.host).toBe("10.1.1.4");
    expect(profileFromContainer({ ...seen, ip: null, published: {} }, "p")?.host).toBe("127.0.0.1");
  });

  it("from an archive does not claim this computer's saved password for another place", () => {
    const mine = { ...newProfile("postgres", "d"), hasSavedPassword: true };
    const server = (host: string) =>
      ({ id: "s", host: "srv", port: 22, username: "root", keyPath: null, logins: [], proxy: null, databases: [{ ...mine, host }] }) as unknown as ServerProfile;
    const remapped = (host: string) => remapServers([server(host)], new Map() as never, new Map() as never, [server("127.0.0.1")])[0].databases[0];
    expect(remapped("127.0.0.1").hasSavedPassword).toBe(true);
    expect(remapped("10.0.0.9").hasSavedPassword).toBe(false);
  });
});

describe("activity", () => {
  it("names a blocker once and says when a session to stop was not there", () => {
    const row = ["7", "app", "", "local", "db", "active", "", "1", "1", "1", "9,9", "q"];
    expect(parseSessions("postgres", answer([row]), null)[0].blockedBy).toEqual(["9"]);
    expect(stopReached("postgres", answer([["f"]]))).toBe(false);
    expect(stopReached("postgres", answer([["t"]]))).toBe(true);
    expect(stopReached("mysql", answer([]))).toBe(true);
    expect(activityQueries("postgres", "16").stats).toContain("pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()");
  });
});

describe("a plan", () => {
  const scan = (name: string): PlanNode => ({ label: `Table scan on ${name}`, detail: "", estRows: 1, actualRows: null, loops: 1, totalMs: null, selfMs: null, cost: null, children: [], warn: { kind: "seqScan", relation: { schema: null, name } } });
  const resolved = (name: string, sql: string) => {
    const plan: Plan = { root: scan(name), analyzed: false, planningMs: null, executionMs: null };
    resolveAliases(plan, sql);
    return plan.root.warn?.relation;
  };

  it("advises about the table behind MySQL's alias, or about none", () => {
    expect(resolved("o", "SELECT * FROM shop.orders AS o WHERE o.a = 1")).toEqual({ schema: "shop", name: "orders" });
    expect(resolved("u", "SELECT * FROM orders o JOIN users u ON u.id = o.uid")).toEqual({ schema: null, name: "users" });
    expect(resolved("u", "SELECT * FROM orders o, users u")).toEqual({ schema: null, name: "users" });
    expect(resolved("orders", "SELECT * FROM orders WHERE a = 1")).toEqual({ schema: null, name: "orders" });
    expect(resolved("d", "SELECT * FROM (SELECT 1) d")).toBeUndefined();
  });
});

describe("edits that were not applied", () => {
  it("say which statement and why", () => {
    expect(applyFailureText({ statement: 2, changed: 0, error: null })).toMatch(/2/);
    expect(applyFailureText({ statement: null, changed: null, error: { message: "deferred check", detail: null, hint: null, code: "23503", position: null } })).toContain("deferred check");
  });
});
