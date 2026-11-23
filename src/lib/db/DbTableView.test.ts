import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbColumn, DbOutcome } from "../types";

// A table document and the browse connection over a mocked backend (ADR 0081):
// one connection for the tree and every table of a tab, rows read on by the
// server as the list reaches its end, nothing sent that is not one read,
// nothing counted unless asked.
const env = vi.hoisted(() => ({
  ran: [] as { conn: string; sql: string; rows: number; writable: boolean }[],
  applied: [] as string[][],
  answer: ((_sql: string) => undefined) as (sql: string) => unknown,
  connects: 0,
  closed: [] as string[],
}));

const col = (name: string, table: string | null = "1650", column: string | null = name): DbColumn => ({ name, typeName: "text", numeric: false, table, column, key: false });
const answer = (over: Partial<DbOutcome> = {}): DbOutcome => ({
  columns: [],
  rows: [],
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

vi.mock("../api/db", () => ({
  dbLocalList: vi.fn(async () => []),
  dbSaveLocal: vi.fn(async (list: unknown) => list),
  setServerDatabases: vi.fn(async () => ({})),
  dbForgetPassword: vi.fn(async () => {}),
  dbConnect: vi.fn(async () => {
    env.connects++;
    await new Promise((r) => setTimeout(r, 1));
    return { opened: { connId: `c${env.connects}`, version: "16.6", readOnly: false, prod: false, kind: "postgres", rememberFailed: false }, refused: null };
  }),
  dbQuery: vi.fn(async (conn: string, sql: string, rows: number, writable: boolean) => {
    env.ran.push({ conn, sql, rows, writable });
    await new Promise((r) => setTimeout(r, 1));
    const own = env.answer(sql);
    if (own instanceof Error) throw own.message;
    return own ?? answer();
  }),
  dbApply: vi.fn(async (_id: string, statements: string[]) => {
    env.applied.push(statements);
    return { changed: [1], failure: null };
  }),
  dbCancel: vi.fn(async () => {}),
  dbClose: vi.fn(async (id: string) => {
    env.closed.push(id);
  }),
}));

import * as store from "../stores/db.svelte";
import { setLocale } from "../i18n";
import { settings } from "../settings/settings.svelte";
import type { EditorDoc } from "../stores/workspaces.svelte";
import DbTableView from "./DbTableView.svelte";
import DbValuePanel from "./DbValuePanel.svelte";

const orders = { schema: "public", name: "orders" };
const page = (n: number) =>
  answer({
    columns: [col("id"), col("customer_id")],
    rows: Array.from({ length: n }, (_, i) => [String(i + 1), i === 0 ? "42" : null]),
  });
/** The catalog the browse connection reads: orders → customers. */
function catalogAnswers(sql: string): unknown {
  if (sql === "SELECT current_schema()") return answer({ rows: [["public"]] });
  if (sql.includes("c.relkind IN")) return answer({ rows: [["public", "orders", "r", "1240000"]] });
  if (sql.includes("contype IN ('p', 'f')"))
    return answer({
      rows: [
        ["public", "orders", "p", "id", "", "", "", "orders_pkey"],
        ["public", "orders", "f", "customer_id", "public", "customers", "id", "orders_customer_fkey"],
      ],
    });
  return undefined;
}

let n = 0;
async function openTable(where = ""): Promise<string> {
  const id = `t-${++n}`;
  store.attachDb(id, { sessionId: "s", place: null, dbId: "d", kind: "postgres", view: "table", table: { ref: orders, tableKind: "table", where } });
  await store.connectDb(id);
  await vi.waitFor(() => expect(store.dbDoc(id)?.result).toBeTruthy());
  // Whether its cells may be edited is looked up after the read, by itself.
  await vi.waitFor(() => expect(store.dbDoc(id)?.edit.target).not.toBeNull());
  return id;
}
const pages = () => env.ran.filter((r) => r.sql.startsWith('SELECT * FROM "public"."orders"'));
/** The table's rows `1…total`, as the server reads them by LIMIT and OFFSET. */
function upTo(sql: string, total: number): DbOutcome {
  const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1]);
  const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1]);
  const n = Math.max(0, Math.min(limit, total - offset));
  return answer({ columns: [col("id"), col("customer_id")], rows: Array.from({ length: n }, (_, i) => [String(offset + i + 1), null]) });
}
/** What the edits ask of the table: its key. */
const editMeta = (sql: string) =>
  sql.includes("pg_attribute a ON a.attrelid = c.oid")
    ? answer({ rows: [["public", "orders", "id", "id", "1", "1"], ["public", "orders", "customer_id", "customer_id", "0", "1"]] })
    : undefined;
/** The grid measured at `h` px, as the browser would tell it. */
async function measure(grid: HTMLElement, h: number) {
  Object.defineProperty(grid, "clientHeight", { value: h, configurable: true });
  // Only the observers of the grid: another's (CodeMirror's) would measure text jsdom does not lay out.
  const observers = (ResizeObserver as unknown as { instances: { cb: ResizeObserverCallback; targets: Set<Element> }[] }).instances;
  for (const ro of observers.filter((o) => o.targets.has(grid))) ro.cb([{ target: grid } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver);
  await Promise.resolve();
}
async function scrollTo(grid: HTMLElement, top: number) {
  Object.defineProperty(grid, "scrollTop", { value: top, configurable: true });
  await fireEvent.scroll(grid);
}

beforeEach(() => {
  setLocale("en");
  env.ran.length = 0;
  env.applied.length = 0;
  env.closed.length = 0;
  env.connects = 0;
  env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? page(3) : undefined);
});
afterEach(() => {
  // The views first: a document forgotten under a mounted view is read by it once more.
  cleanup();
  store.forgetDb("s");
  settings.dbPageRows = 200;
});

describe("the browse connection", () => {
  it("is one for the tree and every table of the tab, and reads a page a row longer than it shows", async () => {
    const a = await openTable();
    const b = await openTable("id > 1");
    expect(env.connects).toBe(1);
    expect(store.browseDoc("s", "d")?.conn?.id).toBe("c1");
    expect(new Set(env.ran.map((r) => r.conn))).toEqual(new Set(["c1"]));
    expect(pages().map((r) => [r.sql, r.rows])).toEqual([
      ['SELECT * FROM "public"."orders" LIMIT 201 OFFSET 0', 201],
      [`SELECT * FROM "public"."orders" WHERE (id > 1\n) LIMIT 201 OFFSET 0`, 201],
    ]);
    // The catalog was read on it too: the tree needs no console.
    expect(store.catalogOf(null, "d")?.catalog?.keys["public.orders"]?.primary).toEqual(["id"]);
    expect(store.dbDoc(a)?.conn).toBeNull();
    expect(store.dbDoc(b)?.via).toBe(store.browseId("s", "d"));
  });

  it("outlives a table closed, and ends with the tab — or when disconnected", async () => {
    const id = await openTable();
    store.closeDbDoc(id);
    expect(env.closed).toEqual([]);
    expect(store.dbWorking("s")).toEqual([]);
    const again = await openTable();
    store.closeBrowse("s", "d");
    expect(env.closed).toEqual(["c1"]);
    // The table asks to connect it again, and then reads on the new one.
    expect(store.tableConn(again)).toBeNull();
    await store.connectDb(again);
    await vi.waitFor(() => expect(store.browseDoc("s", "d")?.conn?.id).toBe("c2"));
    store.forgetDb("s");
    expect(env.closed).toEqual(["c1", "c2"]);
  });
});

describe("a table's rows", () => {
  it("never sends a filter that is not one read", async () => {
    const id = await openTable();
    env.ran.length = 0;
    for (const [where, why] of [
      ["1 = 1; DROP TABLE orders", "many"],
      ["nextval('orders_id_seq') > 0", "notRead"],
      ["note = 'it''s", "open"],
    ] as const) {
      expect(await store.readTable(id, { where })).toBe(false);
      expect(store.dbDoc(id)?.table?.refusal).toBe(why);
    }
    expect(env.ran).toEqual([]);
    // The page shown stays the one read without it.
    expect(store.dbDoc(id)?.table?.where).toBe("");
  });

  it("sorts by the server on a header click", async () => {
    env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? page(201) : undefined);
    const id = await openTable();
    const doc = { id, db: { place: null, dbId: "d", kind: "postgres", view: "table", table: orders } } as unknown as EditorDoc;
    render(DbTableView, { doc, profile: null, serverName: "here", onopen: vi.fn(), onconsole: vi.fn() });
    expect(screen.getByTestId("db-table-range").textContent).toBe("1–200");
    await fireEvent.click(screen.getAllByTestId("db-sort")[0]);
    await waitFor(() => expect(pages().at(-1)?.sql).toBe('SELECT * FROM "public"."orders" ORDER BY "id" ASC\n LIMIT 201 OFFSET 0'));
  });

  it("reads on when its list is scrolled to the end, keeping the edits, until the last row", async () => {
    env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? upTo(sql, 450) : editMeta(sql));
    const id = await openTable();
    await store.prepareEdit(id);
    store.editDbCell(id, 0, 1, "7");
    const doc = { id, db: { place: null, dbId: "d", kind: "postgres", view: "table", table: orders } } as unknown as EditorDoc;
    render(DbTableView, { doc, profile: null, serverName: "here", onopen: vi.fn(), onconsole: vi.fn() });
    const grid = screen.getByTestId("db-grid");
    await measure(grid, 240);
    expect(pages()).toHaveLength(1);
    // A screen before the 200th row: the next 200 are read and added below — no question, the edit stays.
    await scrollTo(grid, 195 * 24);
    await waitFor(() => expect(screen.getByTestId("db-table-range").textContent).toBe("1–400"));
    expect(pages().at(-1)?.sql).toBe('SELECT * FROM "public"."orders" LIMIT 201 OFFSET 200');
    expect(store.dbDoc(id)?.result?.outcome.rows[200]).toEqual(["201", null]);
    expect(store.pendingCount(id)).toBe(1);
    expect(screen.queryByText("Discard and read")).toBeNull();
    // The button reads on just the same; the last 50 rows end the table.
    await fireEvent.click(screen.getByTestId("db-table-more"));
    await waitFor(() => expect(screen.getByTestId("db-table-range").textContent).toBe("1–450"));
    expect(pages().at(-1)?.sql).toBe('SELECT * FROM "public"."orders" LIMIT 201 OFFSET 400');
    expect(screen.queryByTestId("db-table-more")).toBeNull();
    await scrollTo(grid, 450 * 24);
    await new Promise((r) => setTimeout(r, 10));
    expect(pages()).toHaveLength(3);
    // Applied, the rows shown are read again — all of them: the list stays where it was.
    expect(await store.applyDbEdits(id, false)).toBe(true);
    await vi.waitFor(() => expect(pages().at(-1)?.sql).toBe('SELECT * FROM "public"."orders" LIMIT 451 OFFSET 0'));
    await vi.waitFor(() => expect(store.dbDoc(id)?.result?.outcome.rows).toHaveLength(450));
    // A new sort starts from the top, a page of rows.
    await fireEvent.click(screen.getAllByTestId("db-sort")[0]);
    await waitFor(() => expect(pages().at(-1)?.sql).toBe('SELECT * FROM "public"."orders" ORDER BY "id" ASC\n LIMIT 201 OFFSET 0'));
  });

  it("adds nothing to rows a read from the start replaced first", async () => {
    env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? upTo(sql, 450) : undefined);
    const id = await openTable();
    const filtered = store.readTable(id, { where: "id > 5" });
    expect(await store.readMoreTable(id)).toBe(false);
    expect(await filtered).toBe(true);
    expect(pages().some((r) => r.sql.includes("OFFSET 200"))).toBe(false);
    expect(store.dbDoc(id)?.table?.more).toBeNull();
    expect(store.dbDoc(id)?.result?.outcome.rows).toHaveLength(200);
  });

  it("stops reading on when the table's columns changed, and says so", async () => {
    let altered = false;
    env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? (altered ? answer({ columns: [col("id")], rows: [["201"]] }) : upTo(sql, 450)) : undefined);
    const id = await openTable();
    const doc = { id, db: { place: null, dbId: "d", kind: "postgres", view: "table", table: orders } } as unknown as EditorDoc;
    render(DbTableView, { doc, profile: null, serverName: "here", onopen: vi.fn(), onconsole: vi.fn() });
    altered = true;
    expect(await store.readMoreTable(id)).toBe(false);
    expect(await screen.findByTestId("db-table-more-changed")).toBeTruthy();
    expect(store.dbDoc(id)?.result?.outcome.rows).toHaveLength(200);
    const before = pages().length;
    expect(await store.readMoreTable(id)).toBe(false);
    expect(pages()).toHaveLength(before);
    // Read again from the start, it reads on again.
    altered = false;
    expect(await store.readTable(id, {}, "shown")).toBe(true);
    expect(await store.readMoreTable(id)).toBe(true);
    expect(store.dbDoc(id)?.result?.outcome.rows).toHaveLength(400);
  });

  it("holds at most ten thousand rows, and says so", async () => {
    settings.dbPageRows = 1000;
    env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? upTo(sql, 50_000) : undefined);
    const id = await openTable();
    const doc = { id, db: { place: null, dbId: "d", kind: "postgres", view: "table", table: orders } } as unknown as EditorDoc;
    render(DbTableView, { doc, profile: null, serverName: "here", onopen: vi.fn(), onconsole: vi.fn() });
    // Measured, the grid draws the rows on screen, not ten thousand of them.
    await measure(screen.getByTestId("db-grid"), 240);
    for (let i = 0; i < 9; i++) expect(await store.readMoreTable(id)).toBe(true);
    expect(store.dbDoc(id)?.result?.outcome.rows).toHaveLength(10_000);
    expect(store.dbDoc(id)?.table?.hasNext).toBe(true);
    const before = pages().length;
    expect(await store.readMoreTable(id)).toBe(false);
    expect(pages()).toHaveLength(before);
    expect((await screen.findByTestId("db-table-capped")).textContent).toContain("10,000");
    expect(screen.queryByTestId("db-table-more")).toBeNull();
    // Read again, the ten thousand shown are one answer — the backend's cap — and there are still more.
    expect(await store.readTable(id, {}, "shown")).toBe(true);
    expect(pages().at(-1)?.sql).toBe('SELECT * FROM "public"."orders" LIMIT 10001 OFFSET 0');
  });

  it("draws its filter fields in the row's own text, not the console's", async () => {
    const id = await openTable();
    const doc = { id, db: { place: null, dbId: "d", kind: "postgres", view: "table", table: orders } } as unknown as EditorDoc;
    render(DbTableView, { doc, profile: null, serverName: "here", onopen: vi.fn(), onconsole: vi.fn() });
    for (const field of screen.getAllByTestId("sql-field")) {
      expect(field.className).toContain("font-mono");
      expect(field.className).toContain("text-meta");
      expect(field.className).not.toContain("text-sm");
    }
    expect(screen.getByTestId("db-table-apply").className).toContain("h-[1.375rem]");
  });

  it("knows whether its cells may be edited before anyone asks, and says why not in the menu", async () => {
    const keyless = (sql: string) =>
      sql.includes("pg_attribute a ON a.attrelid = c.oid")
        ? answer({ rows: [["public", "orders", "id", "id", "0", "1"], ["public", "orders", "customer_id", "customer_id", "0", "1"]] })
        : undefined;
    env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? page(3) : keyless(sql));
    const id = await openTable();
    expect(store.dbDoc(id)?.edit.target).toBe("noKey");
    const doc = { id, db: { place: null, dbId: "d", kind: "postgres", view: "table", table: orders } } as unknown as EditorDoc;
    render(DbTableView, { doc, profile: null, serverName: "here", onopen: vi.fn(), onconsole: vi.fn() });
    const cell = screen.getAllByRole("gridcell")[1];
    await fireEvent.contextMenu(cell);
    expect((screen.getByRole("menuitem", { name: "Edit the value" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Not editable: the table has no primary key.").some((el) => el.hasAttribute("data-menu-note"))).toBe(true);
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await fireEvent.dblClick(cell);
    expect(screen.getByTestId("db-edit-refused").textContent).toContain("no primary key");
    // With a key, the same double click edits.
    env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? page(3) : editMeta(sql));
    expect(await store.readTable(id, {}, "shown")).toBe(true);
    await vi.waitFor(() => expect(typeof store.dbDoc(id)?.edit.target).toBe("object"));
    await fireEvent.dblClick(screen.getAllByRole("gridcell")[1]);
    await waitFor(() => expect(screen.getAllByRole("gridcell")[1].querySelector("input, textarea")).toBeTruthy());
  });

  it("keeps a refused filter in its field, to be fixed", async () => {
    const id = await openTable();
    const doc = { id, db: { place: null, dbId: "d", kind: "postgres", view: "table", table: orders } } as unknown as EditorDoc;
    render(DbTableView, { doc, profile: null, serverName: "here", onopen: vi.fn(), onconsole: vi.fn() });
    const { EditorView } = await import("@codemirror/view");
    const field = EditorView.findFromDOM(screen.getAllByTestId("sql-field")[0].querySelector(".cm-editor") as HTMLElement)!;
    const typed = "status = 'x'; DELETE FROM orders";
    field.dispatch({ changes: { from: 0, insert: typed } });
    const before = env.ran.length;
    await fireEvent.click(screen.getByTestId("db-table-apply"));
    expect(await screen.findByTestId("db-table-refusal")).toBeTruthy();
    expect(env.ran.length).toBe(before);
    expect(field.state.doc.toString()).toBe(typed);
  });

  it("counts only when asked, and keeps an unfiltered count for the tree", async () => {
    env.answer = (sql) => catalogAnswers(sql) ?? (sql.startsWith("SELECT count(*)") ? answer({ rows: [["1240133"]] }) : sql.startsWith("SELECT * FROM") ? page(3) : undefined);
    const id = await openTable();
    expect(env.ran.some((r) => r.sql.startsWith("SELECT count(*)"))).toBe(false);
    await store.countTable(id);
    expect(store.dbDoc(id)?.table?.count?.n).toBe(1240133);
    expect(store.exactCount(null, "d", orders)).toBe(1240133);
    await store.readTable(id, { where: "id > 5" });
    expect(store.dbDoc(id)?.table?.count).toBeNull();
  });

  it("follows a foreign key to the row it names", async () => {
    const id = await openTable();
    await vi.waitFor(() => expect(store.catalogOf(null, "d")?.catalog).toBeTruthy());
    const onopen = vi.fn();
    const doc = { id, db: { place: null, dbId: "d", kind: "postgres", view: "table", table: orders } } as unknown as EditorDoc;
    render(DbTableView, { doc, profile: null, serverName: "here", onopen, onconsole: vi.fn() });
    Object.defineProperty(screen.getByTestId("db-grid"), "clientHeight", { value: 240, configurable: true });
    // Only a value leads somewhere: the NULLs of the column have no arrow.
    const arrows = await screen.findAllByTestId("db-follow");
    expect(arrows).toHaveLength(1);
    await fireEvent.click(arrows[0]);
    expect(onopen).toHaveBeenCalledWith({ schema: "public", name: "customers" }, `"id" = '42'`);
  });

  it("applies its edits on the browse connection and reads its page again", async () => {
    env.answer = (sql) =>
      catalogAnswers(sql) ??
      (sql.startsWith("SELECT * FROM")
        ? page(2)
        : sql.includes("pg_attribute a ON a.attrelid = c.oid")
          ? answer({ rows: [["public", "orders", "id", "id", "1", "1"], ["public", "orders", "customer_id", "customer_id", "0", "1"]] })
          : undefined);
    const id = await openTable();
    await store.prepareEdit(id);
    store.editDbCell(id, 0, 1, "7");
    expect(store.browseWork("s", "d")).toBe("edits");
    const before = pages().length;
    expect(await store.applyDbEdits(id, false)).toBe(true);
    expect(env.applied[0]).toEqual([`UPDATE "public"."orders" SET "customer_id" = '7' WHERE "id" = '1'`]);
    await vi.waitFor(() => expect(pages().length).toBe(before + 1));
  });
});

describe("structure and DDL", () => {
  it("reads the structure once shown, and puts PostgreSQL's DDL together saying so", async () => {
    env.answer = (sql) => {
      if (sql.startsWith("SELECT a.attnum::text")) return answer({ rows: [["1", "id", "bigint", "0", null, null, "a", ""]] });
      if (sql.startsWith("SELECT c.relname, pg_get_indexdef")) return answer({ rows: [["orders_pkey", "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)", "1", "1", "8192", "1", null, null]] });
      if (sql.startsWith("SELECT conname, pg_get_constraintdef")) return answer({ rows: [["orders_pkey", "PRIMARY KEY (id)", "p"]] });
      return catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? page(1) : undefined);
    };
    const id = await openTable();
    env.ran.length = 0;
    store.showTableTab(id, "structure");
    await vi.waitFor(() => expect(store.dbDoc(id)?.table?.structure?.data?.columns[0]?.name).toBe("id"));
    expect(env.ran).toHaveLength(4);
    store.showTableTab(id, "ddl");
    await vi.waitFor(() => expect(store.dbDoc(id)?.table?.ddl?.text).toBeTruthy());
    expect(store.dbDoc(id)?.table?.ddl).toMatchObject({ how: "assembled", text: 'CREATE TABLE "public"."orders" (\n  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,\n  CONSTRAINT "orders_pkey" PRIMARY KEY (id)\n);\n' });
    // The structure was not read twice for it.
    expect(env.ran.filter((r) => r.sql.startsWith("SELECT a.attnum::text"))).toHaveLength(1);
  });
});

describe("the value beside the rows", () => {
  const keys = { primary: ["id"], foreign: [{ name: "fk", columns: ["customer_id"], ref: { schema: "public", name: "customers" }, refColumns: ["id"] }] };
  const incoming = [{ from: { schema: "public", name: "lines" }, fk: { name: "lines_fk", columns: ["order_id"], ref: orders, refColumns: ["id"] } }];
  const o = answer({
    columns: [col("id"), col("customer_id"), { ...col("meta"), typeName: "JSONB" }],
    rows: [["7", "42", '{"a":12345678901234567890,"b":[1]}']],
    cut: [[0, 2]],
  });
  const props = (cell: { row: number; col: number } | null, over: object = {}) => ({
    outcome: o,
    cell,
    kind: "postgres" as const,
    keys,
    incoming,
    full: null,
    backslashEscapes: false,
    onfollow: vi.fn(),
    onreadAll: vi.fn(),
    ...over,
  });

  it("lays JSON out as it was written, and offers to read a cut value to its end by the row's key", async () => {
    const p = props({ row: 0, col: 2 });
    render(DbValuePanel, p);
    expect(screen.getByTestId("db-value-text").textContent).toBe('{\n  "a": 12345678901234567890,\n  "b": [\n    1\n  ]\n}');
    expect(screen.getByText(`row "id" = '7'`)).toBeTruthy();
    await fireEvent.click(screen.getByTestId("db-value-read"));
    expect(p.onreadAll).toHaveBeenCalledWith(0, 2);
  });

  it("does not offer it without a primary key, and leads to the row a key names and to the rows pointing back", async () => {
    render(DbValuePanel, props({ row: 0, col: 2 }, { keys: { primary: [], foreign: [] } }));
    expect(screen.queryByTestId("db-value-read")).toBeNull();
    expect(screen.getByText("Not read further: the table has no primary key.")).toBeTruthy();
    document.body.innerHTML = "";
    const p = props({ row: 0, col: 1 });
    render(DbValuePanel, p);
    await fireEvent.click(screen.getByTestId("db-value-to"));
    expect(p.onfollow).toHaveBeenCalledWith({ schema: "public", name: "customers" }, `"id" = '42'`);
    await fireEvent.click(screen.getByTestId("db-value-from"));
    expect(p.onfollow).toHaveBeenLastCalledWith({ schema: "public", name: "lines" }, `"order_id" = '7'`);
  });

  it("reads a long value in parts, by the key, and stops at the cap", async () => {
    env.answer = (sql) => {
      if (sql.startsWith("SELECT length(")) return answer({ rows: [["40000"]] });
      if (sql.startsWith("SELECT substr(")) {
        const from = Number(/, (\d+), 16384\)/.exec(sql)?.[1]);
        return answer({ rows: [["y".repeat(Math.min(16384, 40000 - from + 1))]] });
      }
      return catalogAnswers(sql) ?? (sql.startsWith("SELECT * FROM") ? page(1) : undefined);
    };
    const id = await openTable();
    env.ran.length = 0;
    await store.readFullValue(id, 0, 1, ["id"]);
    expect(env.ran.map((r) => r.sql)).toEqual([
      `SELECT length("customer_id"::text) FROM "public"."orders" WHERE "id" = '1'`,
      `SELECT substr("customer_id"::text, 1, 16384) FROM "public"."orders" WHERE "id" = '1'`,
      `SELECT substr("customer_id"::text, 16385, 16384) FROM "public"."orders" WHERE "id" = '1'`,
      `SELECT substr("customer_id"::text, 32769, 16384) FROM "public"."orders" WHERE "id" = '1'`,
    ]);
    expect(store.dbDoc(id)?.table?.value).toMatchObject({ row: 0, col: 1, loading: false, error: null, capped: false });
    expect(store.dbDoc(id)?.table?.value?.text?.length).toBe(40000);
  });
});
