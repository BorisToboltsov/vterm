import { describe, expect, it } from "vitest";
import { consoleArgv, kindOfImage, newProfile, profileAddress, profileFromContainer, profileIssue, profileTitle } from "./dbprofile";
import { dbFailure } from "./dberror";
import { quoteIdent, quoteLiteral, quoteTable } from "./dbquote";
import { columnChars, cellLine, exportName, exportRows } from "./dbgrid";
import { catalogQueries, completionNames, firstRowsSql, parseColumns, parseIndexes, parseRoutines, parseTableMeta, parseTables, schemasOf, tableMetaSql, type Catalog } from "./dbcatalog";
import type { DbOutcome } from "../types";

const answer = (rows: (string | null)[][], numeric: boolean[] = []): DbOutcome => ({
  columns: (rows[0] ?? []).map((_, i) => ({ name: `c${i}`, typeName: "text", numeric: numeric[i] ?? false, table: null, column: null, key: false })),
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

describe("profiles", () => {
  it("start on the server's loopback and are named by what is set", () => {
    const p = newProfile("postgres", "a");
    expect(p).toMatchObject({ host: "127.0.0.1", port: 5432, user: "postgres", database: "postgres" });
    expect(newProfile("mysql", "b")).toMatchObject({ port: 3306, user: "root", database: "" });
    expect(profileTitle({ ...p, name: "billing" })).toBe("billing");
    expect(profileTitle({ ...p, database: "" })).toBe("127.0.0.1:5432");
    expect(profileAddress({ ...p, host: "/var/run/postgresql" })).toBe("PostgreSQL · /var/run/postgresql");
  });

  it("are checked field by field", () => {
    const p = newProfile("postgres", "a");
    expect(profileIssue(p)).toBeNull();
    expect(profileIssue({ ...p, host: " " })).toBe("host");
    expect(profileIssue({ ...p, port: 70000 })).toBe("port");
    expect(profileIssue({ ...p, user: "a\nb" })).toBe("user");
  });

  it("come from a database container: its published port, else its address; never its password", () => {
    expect(kindOfImage("docker.io/library/postgres:16-alpine")).toBe("postgres");
    expect(kindOfImage("bitnami/mariadb@sha256:abc")).toBe("mysql");
    expect(kindOfImage("redis:7")).toBeNull();
    const pg = profileFromContainer({ name: "db-1", image: "postgres:16", ip: "172.18.0.4", published: {}, env: { POSTGRES_USER: "app", POSTGRES_DB: "billing" } }, "x");
    expect(pg).toMatchObject({ kind: "postgres", host: "172.18.0.4", port: 5432, user: "app", database: "billing", container: "db-1" });
    const my = profileFromContainer({ name: "m", image: "mysql:8.4", ip: null, published: { 3306: 13306 }, env: {} }, "y");
    expect(my).toMatchObject({ host: "127.0.0.1", port: 13306, user: "root" });
    // Stopped, or on the host's network: the form opens on the loopback rather than the menu doing nothing.
    expect(profileFromContainer({ name: "n", image: "mysql", ip: null, published: {}, env: {} }, "z")?.host).toBe("127.0.0.1");
    expect(profileFromContainer({ name: "r", image: "redis:7", ip: null, published: {}, env: {} }, "z")).toBeNull();
  });

  it("open the user's own client, which asks the password itself", () => {
    const p = { ...newProfile("postgres", "a"), database: "billing", user: "app" };
    expect(consoleArgv(p)).toEqual(["psql", "-h", "127.0.0.1", "-p", "5432", "-U", "app", "-d", "billing"]);
    expect(consoleArgv({ ...p, host: "/run/pg" })).toEqual(["psql", "-h", "/run/pg", "-U", "app", "-d", "billing"]);
    expect(consoleArgv({ ...newProfile("mysql", "b"), database: "shop" })).toEqual(["mysql", "-h", "127.0.0.1", "-P", "3306", "-u", "root", "-p", "shop"]);
    expect(consoleArgv({ ...p, container: "db-1" })).toEqual(["docker", "exec", "-it", "db-1", "psql", "-U", "app", "-d", "billing"]);
    for (const argv of [consoleArgv(p), consoleArgv({ ...p, container: "c" })]) expect(argv.join(" ")).not.toMatch(/password|PGPASSWORD/i);
  });
});

describe("refusals", () => {
  it("are read by their marker", () => {
    expect(dbFailure("db-auth-rejected: the database did not accept the user or the password")).toEqual({ kind: "auth" });
    expect(dbFailure(new Error("db-tunnel-refused: db:5432: Channel open failure"))).toEqual({ kind: "tunnel", detail: "db:5432: Channel open failure" });
    expect(dbFailure("db-closed: x").kind).toBe("closed");
    const marked: [string, string][] = [
      ["db-read-only", "readOnly"],
      ["db-lift-scope", "liftScope"],
      ["db-tx-open", "txOpen"],
      ["db-many-statements", "many"],
      ["db-not-an-edit", "notEdit"],
      ["db-not-local", "notLocal"],
      ["db-bad-profile", "badProfile"],
    ];
    for (const [marker, kind] of marked) expect(dbFailure(`${marker}: x`).kind).toBe(kind);
    expect(dbFailure("boom")).toEqual({ kind: "other", detail: "boom" });
  });
});

describe("quoting", () => {
  it("quotes names and values the dialect's way", () => {
    expect(quoteIdent('a"b', "postgres")).toBe('"a""b"');
    expect(quoteIdent("a`b", "mysql")).toBe("`a``b`");
    expect(quoteTable("s", "t", "postgres")).toBe('"s"."t"');
    expect(quoteLiteral("it's", "postgres")).toBe("'it''s'");
    expect(quoteLiteral("a\\'b", "mysql")).toBe("'a\\\\''b'");
    expect(quoteLiteral("a\\b", "postgres")).toBe("'a\\b'");
    expect(quoteLiteral(null, "mysql")).toBe("NULL");
  });
});

describe("grid and export", () => {
  const o = answer(
    [
      ["1", 'say "hi", ok', null],
      ["22", "line\nbreak", "x|y"],
    ],
    [true],
  );

  it("sizes a column by its name and early values, and reads a cell in one line", () => {
    expect(columnChars(o, 1)).toBe(12);
    expect(cellLine(null)).toBe("NULL");
    expect(cellLine("a\nb")).toBe("a↵b");
    expect(cellLine("x".repeat(10), 4)).toBe("xxxx…");
  });

  it("exports the rows shown in each format", () => {
    expect(exportRows(o, "csv", "postgres")).toBe('c0,c1,c2\n1,"say ""hi"", ok",\n22,"line\nbreak",x|y\n');
    expect(JSON.parse(exportRows(o, "json", "postgres"))[0]).toEqual({ c0: "1", c1: 'say "hi", ok', c2: null });
    expect(exportRows(o, "markdown", "postgres")).toContain("| ---: | --- | --- |");
    expect(exportRows(o, "markdown", "postgres")).toContain("x\\|y");
    expect(exportRows(o, "insert", "mysql", { schema: null, name: "t" })).toContain("INSERT INTO `t` (`c0`, `c1`, `c2`) VALUES ('1', 'say \"hi\", ok', NULL);");
    expect(exportName("billing.sql", "markdown")).toBe("billing.sql.md");
    expect(exportName("a b", "insert")).toBe("a_b.sql");
  });
});

describe("catalog", () => {
  it("reads tables, routines, columns and the schema a bare name means", () => {
    const tables = parseTables("postgres", answer([["public", "invoices", "r", "300000"], ["public", "v", "v", "-1"], ["app", "m", "m", null]]));
    expect(tables).toEqual([
      { schema: "public", name: "invoices", kind: "table", rows: 300000 },
      { schema: "public", name: "v", kind: "view", rows: null },
      { schema: "app", name: "m", kind: "matview", rows: null },
    ]);
    expect(parseTables("mysql", answer([["shop", "orders", "BASE TABLE", "12"], ["shop", "vv", "VIEW", null]]))[1].kind).toBe("view");
    expect(parseRoutines(answer([["public", "f", "a integer", "f"], ["shop", "p", "", "PROCEDURE"]])).map((r) => r.kind)).toEqual(["function", "procedure"]);
    const cat: Catalog = { tables, routines: [], columns: parseColumns(answer([["public", "invoices", "id", "integer"], ["public", "invoices", "status", "text"]])), current: "public" };
    expect(schemasOf(cat)).toEqual(["public", "app"]);
    expect(completionNames(cat).public.invoices).toEqual(["id", "status"]);
    expect(firstRowsSql("mysql", { schema: "shop", name: "orders" })).toBe("SELECT * FROM `shop`.`orders` LIMIT 100");
  });

  it("asks one table's meta safely and reads its key in order", () => {
    expect(tableMetaSql("postgres", "1650; drop")).toContain("WHERE c.oid = 0");
    expect(tableMetaSql("mysql", "shop.o'rders")).toContain("'o''rders'");
    const meta = parseTableMeta(answer([["public", "t", "1", "a", "2", "1"], ["public", "t", "2", "b", "0"], ["public", "t", "3", "c", "1"]]));
    expect(meta).toEqual({ schema: "public", name: "t", columns: { "1": "a", "2": "b", "3": "c" }, key: ["c", "a"], transactional: true });
    expect(parseTableMeta(answer([]))).toBeNull();
    expect(parseIndexes(answer([["ix", "status,due_at"], ["pk", "id"]]))).toEqual([["status", "due_at"], ["id"]]);
    expect(catalogQueries("mysql").tables).toContain("information_schema.TABLES");
  });
});
