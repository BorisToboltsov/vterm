import { describe, expect, it } from "vitest";
import type { DbColumn, DbOutcome } from "../types";
import type { TableMeta } from "./dbcatalog";
import { cellEditable, editCount, editStatements, editTarget, plainTable, rowEditable, NO_EDITS, setCell, shownValue, sourceTable, toggleDelete } from "./dbedit";

const col = (name: string, table: string | null, column: string | null, typeName = "text"): DbColumn => ({
  name,
  typeName,
  numeric: false,
  table,
  column,
  key: false,
});

const answer = (columns: DbColumn[], rows: (string | null)[][], cut: [number, number][] = []): DbOutcome => ({
  columns,
  rows,
  cut,
  truncated: false,
  affected: null,
  elapsedMs: 1,
  notices: [],
  error: null,
  read: true,
  tx: "none",
  backslashEscapes: false,
});

const SQL = "SELECT * FROM public.invoices";
const meta: TableMeta = { schema: "public", name: "invoices", columns: { "1": "id", "2": "status", "3": "note" }, key: ["id"], transactional: true };

describe("what can be edited", () => {
  const o = answer([col("id", "1650", "1", "int4"), col("status", "1650", "2"), col("twice", null, null)], [["7", "paid", "14"]]);

  it("is one table whose key the answer holds", () => {
    expect(sourceTable(o)).toBe("1650");
    const t = editTarget(o, "1650", meta, "postgres", SQL);
    expect(typeof t).toBe("object");
    if (typeof t === "string") return;
    expect(t.names).toEqual(["id", "status", null]);
    expect(t.keyCols).toEqual([0]);
    expect(cellEditable(o, t, 0, 1)).toBe(true);
    expect(cellEditable(o, t, 0, 2)).toBe(false);
  });

  it("is not a computed answer, two tables, a table without a key or an answer without it", () => {
    expect(sourceTable(answer([col("n", null, null)], []))).toBe("computed");
    expect(sourceTable(answer([col("a", "1", "1"), col("b", "2", "1")], []))).toBe("manyTables");
    expect(editTarget(o, "1650", { ...meta, key: [] }, "postgres", SQL)).toBe("noKey");
    expect(editTarget(answer([col("status", "1650", "2")], [["paid"]]), "1650", meta, "postgres", SQL)).toBe("keyMissing");
    expect(editTarget(o, "1650", null, "postgres", SQL)).toBe("metaFailed");
  });

  it("leaves cut cells and bytes alone", () => {
    const withBytes = answer([col("id", "1", "1"), col("blob", "1", "2", "bytea")], [["1", "\\x00"]], [[0, 0]]);
    const t = editTarget(withBytes, "1", { ...meta, columns: { "1": "id", "2": "blob" } }, "postgres", SQL);
    if (typeof t === "string") throw new Error(t);
    expect(cellEditable(withBytes, t, 0, 0)).toBe(false);
    expect(cellEditable(withBytes, t, 0, 1)).toBe(false);
  });
});

describe("edits", () => {
  const o = answer([col("id", "1650", "1"), col("status", "1650", "2"), col("note", "1650", "3")], [
    ["7", "paid", "it's"],
    ["8", "unpaid", null],
  ]);
  const t = editTarget(o, "1650", meta, "postgres", SQL);
  if (typeof t === "string") throw new Error(t);

  it("keep a value set back to what it was as no change", () => {
    let e = setCell(NO_EDITS, o, 0, 1, "void");
    expect(editCount(e)).toBe(1);
    expect(shownValue(e, o, 0, 1)).toBe("void");
    e = setCell(e, o, 0, 1, "paid");
    expect(editCount(e)).toBe(0);
    expect(toggleDelete(toggleDelete(NO_EDITS, 1), 1)).toEqual(NO_EDITS);
  });

  it("become one statement per row, found by the key as the answer had it", () => {
    let e = setCell(NO_EDITS, o, 0, 2, "o'clock \\ x");
    e = setCell(e, o, 0, 0, "70");
    e = setCell(e, o, 1, 2, "skip me");
    e = toggleDelete(e, 1);
    expect(editStatements(o, t, e, "postgres")).toEqual([
      // Columns in the answer's order, whatever order they were edited in.
      `UPDATE "public"."invoices" SET "id" = '70', "note" = 'o''clock \\ x' WHERE "id" = '7'`,
      `DELETE FROM "public"."invoices" WHERE "id" = '8'`,
    ]);
    expect(editStatements(o, t, setCell(NO_EDITS, o, 0, 2, null), "mysql")[0]).toBe(
      "UPDATE `public`.`invoices` SET `note` = NULL WHERE `id` = '7'",
    );
    // A cell set to the NULL it already was is no change at all.
    expect(editStatements(o, t, setCell(NO_EDITS, o, 1, 2, null), "mysql")).toEqual([]);
    expect(editStatements(o, t, setCell(NO_EDITS, o, 0, 2, "a\\b"), "mysql")[0]).toContain("'a\\\\b'");
    expect(editStatements(o, t, setCell(NO_EDITS, o, 0, 2, "a\\b"), "mysql", false)[0]).toContain("'a\\b'");
    expect(editCount(e)).toBe(2);
  });
});

describe("which rows are one table's", () => {
  it("are a plain SELECT's alone", () => {
    const plain = (sql: string) => plainTable(sql, "postgres");
    expect(plain("select id, note from public.invoices where id in (select 1) order by id, note")).toBe("public.invoices");
    expect(plain("SELECT a IS DISTINCT FROM b, id FROM t")).toBe("t");
    expect(plain("SELECT extract(epoch from at), id FROM ONLY t x LIMIT 5")).toBe("t");
    for (const sql of [
      "SELECT a.id, b.note FROM t a JOIN t b ON true",
      "SELECT a.id, b.note FROM t a, t b",
      "SELECT (SELECT b.id FROM t b LIMIT 1) AS id, note FROM t",
      "SELECT * FROM t UNION ALL SELECT * FROM t",
      "SELECT DISTINCT id FROM t",
      "SELECT id, count(*) FROM t GROUP BY id",
      "SELECT * FROM unnest(ARRAY[1])",
      "WITH x AS (SELECT 1) SELECT * FROM x",
    ])
      expect(plain(sql), sql).toBeNull();
  });

  it("are not those of a change, a twice-named column, another table or one that cannot roll back", () => {
    const o = answer([col("id", "1650", "1", "int4"), col("status", "1650", "2")], [["7", "paid"]]);
    expect(editTarget({ ...o, read: false }, "1650", meta, "postgres", SQL)).toBe("notRead");
    expect(editTarget(o, "1650", { ...meta, transactional: false }, "postgres", SQL)).toBe("notTable");
    expect(editTarget(o, "1650", meta, "postgres", "SELECT * FROM a_view")).toBe("notPlain");
    const twice = answer([col("id", "1650", "1", "int4"), col("again", "1650", "1", "int4")], [["7", "7"]]);
    expect(editTarget(twice, "1650", meta, "postgres", SQL)).toBe("notPlain");
  });

  it("are not found by a key shown as hex, nor by one that was cut", () => {
    const hex = answer([col("id", "1650", "1", "VARBINARY")], [["0xff"]]);
    expect(editTarget(hex, "1650", meta, "postgres", SQL)).toBe("keyMissing");
    const o = answer([col("id", "1650", "1", "text"), col("note", "1650", "3")], [["long", "x"]], [[0, 0]]);
    const t = editTarget(o, "1650", meta, "postgres", SQL);
    if (typeof t === "string") throw new Error(t);
    expect(rowEditable(o, t, 0)).toBe(false);
    expect(cellEditable(o, t, 0, 1)).toBe(false);
  });
});
