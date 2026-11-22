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
    return { connId: `c${env.connects}`, version: "16.6", readOnly: env.readOnly, prod: false, kind: "postgres", rememberFailed: false };
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
});
