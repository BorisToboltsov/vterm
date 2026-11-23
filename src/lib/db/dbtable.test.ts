import { describe, expect, it } from "vitest";
import type { DbColumn, DbOutcome } from "../types";
import { parseKeys, type Catalog } from "./dbcatalog";
import {
  appendPage,
  countSql,
  countTail,
  deadShare,
  ddlQueries,
  followFk,
  followIncoming,
  incomingOf,
  indentJson,
  indexCovers,
  keysOf,
  matchWhere,
  moreRows,
  nextSort,
  orderByOf,
  pageOf,
  pageSql,
  pageTail,
  parseColumns,
  parseForeign,
  parseIndexes,
  parseSize,
  pickSession,
  readRefusal,
  rereadRows,
  rowsText,
  shownValue,
  sizeText,
  sortOf,
  TABLE_ROWS_MAX,
  tableDdl,
  textual,
  valueQueries,
  viewDdl,
} from "./dbtable";

const col = (name: string): DbColumn => ({ name, typeName: "text", numeric: false, table: "1", column: name, key: false });
const out = (rows: (string | null)[][], over: Partial<DbOutcome> = {}): DbOutcome => ({
  columns: [],
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
  ...over,
});
const orders = { schema: "public", name: "orders" };

describe("the sort a header writes", () => {
  it("is a quoted column and a direction, read back only when it is one", () => {
    expect(orderByOf({ column: 'we"ird', dir: "DESC" }, "postgres")).toBe('"we""ird" DESC');
    expect(sortOf('"we""ird" DESC', "postgres")).toEqual({ column: 'we"ird', dir: "DESC" });
    expect(sortOf("`a``b` asc", "mysql")).toEqual({ column: "a`b", dir: "ASC" });
    // Typed by hand: the header shows no arrow for it.
    expect(sortOf("created_at DESC, id", "postgres")).toBeNull();
    expect(sortOf("created_at DESC", "postgres")).toBeNull();
  });

  it("goes ascending, descending, then off; another column starts ascending", () => {
    const a = nextSort(null, "id");
    expect(a).toEqual({ column: "id", dir: "ASC" });
    const b = nextSort(a, "id");
    expect(b).toEqual({ column: "id", dir: "DESC" });
    expect(nextSort(b, "id")).toBeNull();
    expect(nextSort(b, "total")).toEqual({ column: "total", dir: "ASC" });
  });
});

describe("the rows of a table", () => {
  it("asks a row more than it shows, from the rows already read, the filter bracketed on its own line", () => {
    expect(pageSql("postgres", orders, " status = 'x' -- why ", '"id" DESC', 400, 200)).toBe(
      `SELECT * FROM "public"."orders" WHERE (status = 'x' -- why\n) ORDER BY "id" DESC\n LIMIT 201 OFFSET 400`,
    );
    expect(pageSql("mysql", { schema: "shop", name: "orders" }, "", "", 0, 50)).toBe("SELECT * FROM `shop`.`orders` LIMIT 51 OFFSET 0");
    expect(countSql("postgres", orders, "")).toBe('SELECT count(*) FROM "public"."orders"');
    expect(pageSql("postgres", orders, "", "", 0, 350, false)).toBe('SELECT * FROM "public"."orders" LIMIT 350 OFFSET 0');
    expect(pageTail(400, 200)).toEqual(["LIMIT", "201", "OFFSET", "400"]);
    expect(readRefusal("postgres", pageSql("postgres", orders, "id > 5", "", 600, 200), pageTail(600, 200))).toBeNull();
  });

  it("runs only as one read whose user text closed what it opened", () => {
    const check = (where: string, orderBy = "") => readRefusal("postgres", pageSql("postgres", orders, where, orderBy, 0, 200), pageTail(0, 200));
    expect(check("")).toBeNull();
    expect(check("status = 'failed' -- a note")).toBeNull();
    expect(check("id IN (SELECT order_id FROM payments)")).toBeNull();
    // A second statement, a write dressed as a read, text that swallows the rest.
    expect(check("1 = 1; DROP TABLE orders")).toBe("many");
    expect(check("nextval('orders_id_seq') > 0")).toBe("notRead");
    expect(check("note = 'it''s")).toBe("open");
    expect(check("id = 1 /* the rest")).toBe("open");
    expect(check("(id = 1")).toBe("open");
    const count = (where: string) => readRefusal("postgres", countSql("postgres", orders, where), countTail("postgres", orders, where));
    expect(count("")).toBeNull();
    expect(count("total > 10")).toBeNull();
    expect(count("note = 'x")).toBe("open");
  });

  it("drops the extra row and says there is a next page", () => {
    const o = out([["1"], ["2"], ["3"]], { cut: [[2, 0], [1, 0]] });
    const p = pageOf(o, 2);
    expect(p.hasNext).toBe(true);
    expect(p.outcome.rows).toEqual([["1"], ["2"]]);
    expect(p.outcome.cut).toEqual([[1, 0]]);
    expect(pageOf(out([["1"]]), 2)).toEqual({ outcome: out([["1"]]), hasNext: false });
    // The backend stopped at its own cap before the extra row: there are more all the same.
    const capped = pageOf(out([["1"], ["2"]], { truncated: true }), 2);
    expect(capped.hasNext).toBe(true);
    expect(capped.outcome.truncated).toBe(false);
  });

  it("reads on a page at a time up to the most a table holds, and again as many as are shown", () => {
    expect(moreRows(200, 200)).toBe(200);
    expect(moreRows(TABLE_ROWS_MAX - 150, 200)).toBe(150);
    expect(moreRows(TABLE_ROWS_MAX, 200)).toBe(0);
    expect(rereadRows(0, 200)).toBe(200);
    expect(rereadRows(3, 200)).toBe(200);
    expect(rereadRows(1400, 200)).toBe(1400);
    expect(rereadRows(TABLE_ROWS_MAX, 1000)).toBe(TABLE_ROWS_MAX);
  });

  it("adds the rows read on after those shown: their cut cells numbered after them, the columns the shown ones", () => {
    const columns = [col("id"), col("note")];
    const shown = out([["1", "a"], ["2", "b"]], { columns, cut: [[1, 1]], notices: ["first"], tx: "none" });
    const more = out([["3", "c"], ["4", "d"]], { columns: [col("id"), col("note")], cut: [[0, 1]], notices: ["second"], tx: "open" });
    const joined = appendPage(shown, more)!;
    expect(joined.rows).toEqual([["1", "a"], ["2", "b"], ["3", "c"], ["4", "d"]]);
    expect(joined.cut).toEqual([[1, 1], [2, 1]]);
    expect(joined.columns).toBe(columns);
    expect(joined.notices).toEqual(["first", "second"]);
    expect(joined.tx).toBe("open");
    // The table changed between the reads: not more of the same rows.
    expect(appendPage(shown, out([["3"]], { columns: [col("id")] }))).toBeNull();
    expect(appendPage(shown, out([["3", "c"]], { columns: [col("id"), { ...col("note"), typeName: "jsonb" }] }))).toBeNull();
  });
});

describe("keys and the links they make", () => {
  const keys = parseKeys(
    out([
      ["public", "orders", "p", "id", "", "", "", "orders_pkey"],
      ["public", "orders", "f", "customer_id", "public", "customers", "id", "orders_customer_fkey"],
      ["public", "lines", "f", "order_id", "public", "orders", "id", "lines_order_fkey"],
      ["public", "lines", "f", "region", "geo", "places", "region", "lines_place_fkey"],
      ["public", "lines", "f", "code", "geo", "places", "code", "lines_place_fkey"],
    ]),
  );
  const cat: Catalog = { tables: [], routines: [], columns: {}, keys, current: "public" };

  it("groups a key of several columns, in its order", () => {
    expect(keysOf(cat, orders).primary).toEqual(["id"]);
    expect(keysOf(cat, { schema: "public", name: "lines" }).foreign[1]).toEqual({ name: "lines_place_fkey", columns: ["region", "code"], ref: { schema: "geo", name: "places" }, refColumns: ["region", "code"] });
    expect(keysOf(null, orders)).toEqual({ primary: [], foreign: [] });
  });

  it("follows a row's key there and the keys pointing back", () => {
    const o = out([["7", "42", "eu", "x1"]], { columns: [col("id"), col("customer_id"), col("region"), col("code")] });
    expect(followFk("postgres", o, 0, keysOf(cat, orders).foreign[0])).toEqual({ table: { schema: "public", name: "customers" }, where: `"id" = '42'` });
    const inc = incomingOf(cat, orders);
    expect(inc.map((i) => i.from.name)).toEqual(["lines"]);
    expect(followIncoming("mysql", o, 0, inc[0])).toEqual({ table: { schema: "public", name: "lines" }, where: "`order_id` = '7'" });
    // NULL points nowhere; a column the answer lacks — neither.
    expect(matchWhere("postgres", ["a"], [null])).toBeNull();
    expect(followFk("postgres", out([["1"]], { columns: [col("id")] }), 0, keysOf(cat, orders).foreign[0])).toBeNull();
  });
});

describe("structure", () => {
  it("reads columns, indexes and sizes as the server printed them", () => {
    const cols = parseColumns(
      out([
        ["1", "id", "bigint", "0", null, null, "a", ""],
        ["2", "total", "numeric(12,2)", "1", "0", "money", "", ""],
        ["3", "g", "int", "1", "(id * 2)", null, "", "s"],
        ["4", "seen", "datetime", "1", "CURRENT_TIMESTAMP", "", "", "DEFAULT_GENERATED"],
      ]),
    );
    expect(cols[0]).toMatchObject({ name: "id", nullable: false, identity: "always", generated: false, default: null });
    expect(cols[1]).toMatchObject({ nullable: true, default: "0", comment: "money" });
    expect(cols[2].generated).toBe(true);
    expect(cols[3]).toMatchObject({ generated: false, extra: "DEFAULT_GENERATED" });
    const ix = parseIndexes(
      out([
        ["orders_pkey", "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)", "1", "1", "8192", "1", null, null],
        ["PRIMARY", null, "1", "1", null, "0", "id,region", "BTREE"],
      ]),
    );
    expect(ix[0]).toMatchObject({ columns: "btree (id)", unique: true, primary: true, ofConstraint: true, bytes: 8192 });
    expect(ix[1]).toMatchObject({ columns: "btree (id,region)", bytes: null });
    expect(indexCovers("CREATE INDEX a ON b")).toBe("CREATE INDEX a ON b");
    const size = parseSize(out([["100", "20", null, "120", "-1", "90", "10", "3600", null, null, null]]));
    expect(size).toMatchObject({ data: 100, toast: null, estimate: null, analyzedAgo: 3600, vacuumedAgo: null });
    expect(deadShare(size!)).toBe(10);
    expect(deadShare({ ...size!, dead: null })).toBeNull();
    expect(parseSize(out([]))).toBeNull();
  });

  it("splits foreign keys into its own and those pointing at it — one to itself is both", () => {
    const fks = parseForeign(
      out([
        ["orders_customer_fkey", "1", "public", "orders", "customer_id", "public", "customers", "id", "r"],
        ["orders_parent_fkey", "1", "public", "orders", "parent_id", "public", "orders", "id", "c"],
        ["lines_order_fkey", "1", "public", "lines", "order_id", "public", "orders", "id", "CASCADE"],
      ]),
      orders,
    );
    expect(fks.foreign.map((k) => [k.name, k.onDelete])).toEqual([
      ["orders_customer_fkey", "RESTRICT"],
      ["orders_parent_fkey", "CASCADE"],
    ]);
    expect(fks.incoming.map((k) => k.name)).toEqual(["orders_parent_fkey", "lines_order_fkey"]);
  });
});

describe("DDL", () => {
  it("is MySQL's own text, or PostgreSQL's catalog put together — never for a foreign table", () => {
    expect(ddlQueries("mysql", orders, "table")).toEqual({ show: "SHOW CREATE TABLE `public`.`orders`" });
    expect(ddlQueries("postgres", orders, "foreign")).toEqual({});
    expect(Object.keys(ddlQueries("postgres", orders, "partitioned"))).toEqual(["constraints", "partition"]);
    expect(Object.keys(ddlQueries("postgres", orders, "matview"))).toEqual(["view"]);
    const cols = parseColumns(
      out([
        ["1", "id", "bigint", "0", null, null, "d", ""],
        ["2", "status", "text", "0", "'new'::text", null, "", ""],
        ["3", "twice", "integer", "1", "(id * 2)", null, "", "s"],
      ]),
    );
    const ix = parseIndexes(
      out([
        ["orders_pkey", "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)", "1", "1", "0", "1", null, null],
        ["orders_status_idx", "CREATE INDEX orders_status_idx ON public.orders USING btree (status)", "0", "0", "0", "0", null, null],
      ]),
    );
    expect(tableDdl(orders, cols, out([["orders_pkey", "PRIMARY KEY (id)", "p"]]), "RANGE (id)", ix)).toBe(
      [
        'CREATE TABLE "public"."orders" (',
        '  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
        `  "status" text NOT NULL DEFAULT 'new'::text,`,
        '  "twice" integer GENERATED ALWAYS AS ((id * 2)) STORED,',
        '  CONSTRAINT "orders_pkey" PRIMARY KEY (id)',
        ") PARTITION BY RANGE (id);",
        "CREATE INDEX orders_status_idx ON public.orders USING btree (status);",
        "",
      ].join("\n"),
    );
    expect(viewDdl(orders, "matview", " SELECT 1;")).toBe('CREATE MATERIALIZED VIEW "public"."orders" AS\nSELECT 1;\n');
  });
});

describe("a cell's value", () => {
  it("lays JSON out without reading its numbers or strings", () => {
    expect(indentJson('{"id":12345678901234567890,"s":"a\\"b,{c}","e":[],"o":{ }}')).toBe(
      '{\n  "id": 12345678901234567890,\n  "s": "a\\"b,{c}",\n  "e": [],\n  "o": {}\n}',
    );
    expect(indentJson("[1,[2]]")).toBe("[\n  1,\n  [\n    2\n  ]\n]");
    expect(indentJson("not json")).toBeNull();
    expect(indentJson('{"a":1')).toBeNull();
    expect(indentJson("}{")).toBeNull();
    expect(shownValue('{"a":1}', "jsonb")).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(shownValue("{a,b}", "text[]")).toEqual({ text: "{a,b}", json: false });
    expect(shownValue(null, "text")).toBeNull();
  });

  it("reads a long value in parts as text, by the row's key", () => {
    const q = valueQueries("postgres", orders, "meta", `"id" = '7'`);
    expect(q.length).toBe(`SELECT length("meta"::text) FROM "public"."orders" WHERE "id" = '7'`);
    expect(q.part(16385)).toBe(`SELECT substr("meta"::text, 16385, 16384) FROM "public"."orders" WHERE "id" = '7'`);
    expect(valueQueries("mysql", orders, "meta", "x").part(1)).toContain("SUBSTRING(CAST(`meta` AS CHAR), 1, 16384)");
    expect(textual("bytea")).toBe(false);
    expect(textual("jsonb")).toBe(true);
  });
});

describe("the session the tree reads through", () => {
  it("keeps the one with its connection, then the tab in focus, then the first", () => {
    expect(pickSession(["a", "b"], "a", (s) => s === "b")).toBe("b");
    expect(pickSession(["a", "b"], "b", () => false)).toBe("b");
    expect(pickSession(["a", "b"], "z", () => false)).toBe("a");
    expect(pickSession([], "a", () => true)).toBeNull();
  });
});

describe("how numbers read", () => {
  it("sizes and counts in a few characters", () => {
    expect([sizeText(null), sizeText(512), sizeText(8192), sizeText(5 * 1024 ** 2), sizeText(3 * 1024 ** 3)]).toEqual(["—", "512 B", "8 KiB", "5.0 MiB", "3.0 GiB"]);
    expect([rowsText(null), rowsText(950), rowsText(48_200), rowsText(1_240_000)]).toEqual(["", "950", "48 k", "1.2 M"]);
  });
});
