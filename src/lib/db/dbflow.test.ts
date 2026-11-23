import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbColumn, DbOutcome } from "../types";

// The database store and its views over a mocked backend (ADR 0080): what the
// store sends, what it never sends twice, and what a view does with the answer.
const env = vi.hoisted(() => ({
  ran: [] as { sql: string; writable: boolean }[],
  applied: [] as string[][],
  readOnly: false,
  answer: ((_sql: string) => undefined) as (sql: string, writable: boolean) => unknown,
  applyAnswer: { changed: [1], failure: null } as unknown,
  connects: 0,
  closed: [] as string[],
}));

const col = (name: string, table: string | null = null, column: string | null = null): DbColumn => ({ name, typeName: "text", numeric: false, table, column, key: false });
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
    return { opened: { connId: `c${env.connects}`, version: "16.6", readOnly: env.readOnly, prod: false, kind: "postgres", rememberFailed: false }, refused: null };
  }),
  dbQuery: vi.fn(async (_id: string, sql: string, _rows: number, writable: boolean) => {
    env.ran.push({ sql, writable });
    await new Promise((r) => setTimeout(r, 1));
    const own = env.answer(sql, writable);
    if (own instanceof Error) throw own.message;
    return own ?? answer();
  }),
  dbApply: vi.fn(async (_id: string, statements: string[]) => {
    env.applied.push(statements);
    return env.applyAnswer;
  }),
  dbCancel: vi.fn(async () => {}),
  dbClose: vi.fn(async (id: string) => {
    env.closed.push(id);
  }),
}));

import * as store from "../stores/db.svelte";
import DbStatus from "./DbStatus.svelte";
import DbActivityView from "./DbActivityView.svelte";
import DbResultGrid from "./DbResultGrid.svelte";

let n = 0;
async function open(view: "console" | "activity" = "console"): Promise<string> {
  const id = `doc-${++n}`;
  store.attachDb(id, { sessionId: "s", place: null, dbId: "d", kind: "postgres", view });
  await store.connectDb(id);
  await vi.waitFor(() => expect(store.dbDoc(id)?.conn).toBeTruthy());
  await new Promise((r) => setTimeout(r, 30));
  return id;
}

const invoice = (read: boolean): DbOutcome => answer({ columns: [col("id", "1650", "1"), col("note", "1650", "2")], rows: [["7", "old"]], read });
const meta = answer({
  rows: [
    ["public", "invoices", "1", "id", "1", "1"],
    ["public", "invoices", "2", "note", "0", "1"],
  ],
});

beforeEach(() => {
  env.ran.length = 0;
  env.applied.length = 0;
  env.closed.length = 0;
  env.connects = 0;
  env.readOnly = false;
  env.answer = () => undefined;
  env.applyAnswer = { changed: [1], failure: null };
});
afterEach(() => store.forgetDb("s"));

describe("edits", () => {
  it("never runs a change again: its returned rows are not editable", async () => {
    const write = "UPDATE invoices SET note = 'old' WHERE id = 7 RETURNING id, note";
    env.answer = (sql) => (sql === write ? invoice(false) : sql.includes("pg_attribute") ? meta : undefined);
    const id = await open();
    await store.runSql(id, write);
    await store.prepareEdit(id);
    store.editDbCell(id, 0, 1, "new");
    await store.applyDbEdits(id, false);
    await new Promise((r) => setTimeout(r, 30));
    expect(env.ran.filter((r) => r.sql === write)).toHaveLength(1);
    expect(env.applied).toHaveLength(0);
  });

  it("applies a read's edits and reads it again", async () => {
    const read = "SELECT id, note FROM invoices";
    env.answer = (sql) => (sql === read ? invoice(true) : sql.includes("pg_attribute") ? meta : undefined);
    const id = await open();
    await store.runSql(id, read);
    await store.prepareEdit(id);
    store.editDbCell(id, 0, 1, "new");
    await store.applyDbEdits(id, false);
    await vi.waitFor(() => expect(env.ran.filter((r) => r.sql === read)).toHaveLength(2));
    expect(env.applied[0][0]).toContain(`SET "note" = 'new' WHERE "id" = '7'`);
  });

  it("are not offered for a self-join: the key would name another row", async () => {
    const read = "SELECT a.id, b.note FROM invoices a JOIN invoices b ON b.parent = a.id";
    env.answer = (sql) => (sql === read ? invoice(true) : sql.includes("pg_attribute") ? meta : undefined);
    const id = await open();
    await store.runSql(id, read);
    await store.prepareEdit(id);
    expect(typeof store.dbDoc(id)?.edit.target).toBe("string");
  });
});

describe("read-only", () => {
  it("asks when the backend found a change the classifier did not, then lifts for that run alone", async () => {
    env.readOnly = true;
    const sneaky = "SELECT app.archive_old_rows()";
    env.answer = (sql, writable) => (sql === sneaky && !writable ? new Error("db-read-only: the statement needs read-only lifted") : undefined);
    const id = await open();
    expect(store.checkRun(id, sneaky)?.lift).toBe(false);
    expect(await store.runSql(id, sneaky)).toBe("readOnly");
    expect(store.dbDoc(id)?.failure).toBeNull();
    expect(await store.runSql(id, sneaky, true)).not.toBe("readOnly");
    await store.runSql(id, "SELECT 1");
    expect(env.ran.slice(-2).map((r) => r.writable)).toEqual([true, false]);
  });

  it("opens no transaction for a lifted statement, and takes back one opened for a refused one", async () => {
    env.readOnly = true;
    const id = await open();
    store.setTxMode(id, "manual");
    env.ran.length = 0;
    await store.runSql(id, "DELETE FROM t WHERE id = 1", true);
    expect(env.ran.map((r) => r.sql)).toEqual(["DELETE FROM t WHERE id = 1"]);
    env.ran.length = 0;
    env.answer = (sql) => (sql.startsWith("SELECT f") ? new Error("db-read-only: x") : sql === "BEGIN" ? answer({ read: false, tx: "open" }) : undefined);
    await store.runSql(id, "SELECT f()");
    expect(env.ran.map((r) => r.sql)).toEqual(["BEGIN", "SELECT f()", "ROLLBACK"]);
  });

  it("stops a session with the lock lifted: its question was the consent", async () => {
    env.readOnly = true;
    env.answer = (sql) => (sql.includes("pg_terminate_backend") ? answer({ rows: [["f"]] }) : undefined);
    const id = await open("activity");
    expect(await store.stopDbSession(id, "42", true)).toMatchObject({ done: false, missing: true });
    expect(env.ran.find((r) => r.sql.includes("pg_terminate_backend"))?.writable).toBe(true);
  });
});

describe("work and connections", () => {
  it("names what closing would lose", async () => {
    env.answer = (sql) => (sql === "BEGIN" ? answer({ read: false, tx: "open" }) : undefined);
    const id = await open();
    expect(store.dbWork(id)).toBeNull();
    await store.runSql(id, "BEGIN");
    expect(store.dbWork(id)).toBe("tx");
    expect(store.dbWorking("s")).toContain(id);
  });

  it("keeps one connection for a document shown again", async () => {
    const id = await open("activity");
    await store.connectDb(id);
    expect(env.connects).toBe(1);
  });

  it("asks the password where the activity is the first to connect", async () => {
    const { dbConnect } = await import("../api/db");
    vi.mocked(dbConnect).mockRejectedValueOnce("db-auth-rejected: x");
    const id = `doc-${++n}`;
    store.attachDb(id, { sessionId: "s", place: null, dbId: "d", kind: "postgres", view: "activity" });
    await store.connectDb(id);
    render(DbStatus, { docId: id, profile: null });
    expect(screen.getByTestId("db-password")).toBeTruthy();
    expect(screen.queryByTestId("db-password-refused")).toBeNull();
  });
});

describe("activity", () => {
  it("is read once when shown, not again for each answer it got", async () => {
    env.answer = (sql) => (sql.includes("max_connections") ? answer({ rows: [["3", "100", "99.9", "f", null]] }) : undefined);
    const id = await open("activity");
    env.ran.length = 0;
    render(DbActivityView, { sessionId: "s", docId: id, visible: true, profile: null, serverName: "srv" });
    await new Promise((r) => setTimeout(r, 150));
    expect(env.ran.filter((r) => r.sql.includes("max_connections"))).toHaveLength(1);
  });
});

describe("grid", () => {
  it("leaves a NULL alone when its editor is left untouched", async () => {
    const edited: unknown[] = [];
    render(DbResultGrid, {
      outcome: answer({ columns: [col("note", "1", "1")], rows: [[null]] }),
      canEdit: () => true,
      onedit: (...a: unknown[]) => edited.push(a),
    });
    Object.defineProperty(screen.getByTestId("db-grid"), "clientHeight", { value: 240, configurable: true });
    const cell = screen.getByRole("gridcell");
    await fireEvent.dblClick(cell);
    const input = await waitFor(() => {
      const el = cell.querySelector("input, textarea");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await fireEvent.blur(input);
    expect(edited).toEqual([]);
  });

  it("says why a cell is not edited — asked before that was known, and after", async () => {
    const wants = vi.fn();
    const outcome = answer({ columns: [col("note", "1", "1")], rows: [["a"]] });
    const { rerender } = render(DbResultGrid, { outcome, canEdit: null, refusal: null, onedit: vi.fn(), onwantEdit: wants });
    const cell = screen.getByRole("gridcell");
    // Not known yet: it is asked, and nothing is said.
    await fireEvent.dblClick(cell);
    expect(wants).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("db-edit-refused")).toBeNull();
    // The answer is "no": said above the rows, not swallowed.
    await rerender({ outcome, canEdit: null, refusal: "Not editable: the table has no primary key.", onedit: vi.fn(), onwantEdit: wants });
    expect(screen.getByTestId("db-edit-refused").textContent).toContain("no primary key");
    expect(cell.querySelector("input, textarea")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("db-edit-refused")).toBeNull();
    // Known: the menu shows the edits off with the reason under them, and a double click says it at once.
    await fireEvent.contextMenu(cell);
    const edit = screen.getByRole("menuitem", { name: "Edit the value" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Not editable: the table has no primary key.").tagName).toBe("P");
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await fireEvent.dblClick(cell);
    expect(screen.getByTestId("db-edit-refused")).toBeTruthy();
    // Another answer: nothing of the last one is said.
    await rerender({ outcome: answer({ columns: [col("note", "1", "1")], rows: [["b"]] }), canEdit: null, refusal: "Not editable: the table has no primary key.", onedit: vi.fn(), onwantEdit: wants });
    expect(screen.queryByTestId("db-edit-refused")).toBeNull();
  });

  /** The grid measured at `h` px — as the browser would tell it — and scrolled to `top`. */
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
  const many = (n: number, cols = [col("id", "1", "1")]) => answer({ columns: cols, rows: Array.from({ length: n }, (_, i) => [String(i + 1)]) });

  it("asks for more rows a screen before its end, and not before it is measured", async () => {
    const onend = vi.fn();
    const first = many(200);
    const { rerender } = render(DbResultGrid, { outcome: first, onend });
    const grid = screen.getByTestId("db-grid");
    // Unmeasured, the window holds every row: that is not the user at the end.
    expect(onend).not.toHaveBeenCalled();
    await measure(grid, 240);
    expect(onend).not.toHaveBeenCalled();
    // Ten rows on screen: within a screen of the 200th, more is asked for — once, however it scrolls on.
    await scrollTo(grid, 180 * 24);
    expect(onend).toHaveBeenCalledTimes(1);
    await scrollTo(grid, 190 * 24);
    expect(onend).toHaveBeenCalledTimes(1);
    // Rows read on below: away from the end again, nothing more is asked.
    await rerender({ outcome: { ...first, rows: [...first.rows, ...many(200).rows] }, onend });
    expect(onend).toHaveBeenCalledTimes(1);
  });

  it("asks again while a short read leaves its view unfilled", async () => {
    const onend = vi.fn();
    const first = many(5);
    const { rerender } = render(DbResultGrid, { outcome: first, onend });
    await measure(screen.getByTestId("db-grid"), 600);
    expect(onend).toHaveBeenCalledTimes(1);
    await rerender({ outcome: { ...first, rows: [...first.rows, ...many(5).rows] }, onend });
    expect(onend).toHaveBeenCalledTimes(2);
  });

  it("keeps the selection over rows read on below, and drops it for another answer", async () => {
    const onselect = vi.fn();
    const first = many(3);
    const { rerender } = render(DbResultGrid, { outcome: first, onselect });
    await fireEvent.click(screen.getAllByRole("gridcell")[1]);
    expect(onselect).toHaveBeenLastCalledWith({ row: 1, col: 0 });
    await rerender({ outcome: { ...first, rows: [...first.rows, ["4"]] }, onselect });
    expect(onselect).toHaveBeenLastCalledWith({ row: 1, col: 0 });
    expect(screen.getAllByRole("gridcell")[1].className).toContain("outline-accent");
    // Another answer — its own columns, though named the same.
    await rerender({ outcome: many(3), onselect });
    expect(onselect).toHaveBeenLastCalledWith(null);
  });
});
