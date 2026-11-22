import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What a database says goes to the screen and no further (ADR 0080). The real
// path from the store through `call()` to the diagnostics and the journal: only
// `invoke` is mocked, every text of the server carries a mark, and the mark is
// looked for in all the window wrote.
const env = vi.hoisted(() => ({
  words: "LEAKMARK Key (email)=(bob@example.com)",
  refuse: false,
  cancelFails: false,
  noted: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { note?: unknown; sql?: string }) => {
    const sqlError = { message: env.words, detail: env.words, hint: env.words, code: "42501", position: null };
    const answer = { columns: [], rows: [], cut: [], truncated: false, affected: null, elapsedMs: 1, notices: [env.words], error: null, read: true, tx: "none", backslashEscapes: false };
    switch (cmd) {
      case "journal_note":
        env.noted.push(args);
        return { rev: 1, total: 1, unreadErrors: false };
      case "db_connect":
        return env.refuse
          ? { opened: null, refused: sqlError }
          : { opened: { connId: "c", version: "16.6", readOnly: false, prod: false, kind: "postgres", rememberFailed: false }, refused: null };
      case "db_query": {
        const sql = args.sql ?? "";
        if (/pg_blocking_pids/.test(sql)) return { ...answer, rows: [["42", "app", "", "local", "app", "active", "", "1", "1", "1", "", "select 1"]] };
        if (/max_connections/.test(sql)) return { ...answer, rows: [["1", "100", "99", "f", null]] };
        return { ...answer, error: sqlError };
      }
      case "db_apply":
        return { changed: [], failure: { statement: 1, changed: null, error: sqlError } };
      case "db_cancel":
        if (env.cancelFails) throw "db-cancel-failed: 1095";
        return null;
      default:
        return null;
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

import { captureDiag } from "../api/diag";
import { setLocale } from "../i18n";
import * as store from "../stores/db.svelte";
import DbActivityView from "./DbActivityView.svelte";
import DbStatus from "./DbStatus.svelte";

let diag: ReturnType<typeof captureDiag>;
let n = 0;
const settle = () => new Promise((r) => setTimeout(r, 30));

async function open(view: "console" | "activity"): Promise<string> {
  const id = `silent-${++n}`;
  store.attachDb(id, { sessionId: "silent", place: null, dbId: "d", kind: "postgres", view });
  await store.connectDb(id);
  await settle();
  return id;
}

beforeEach(() => {
  setLocale("en");
  env.refuse = false;
  env.noted.length = 0;
  diag = captureDiag();
});
afterEach(() => {
  diag.stop();
  store.forgetDb("silent");
});

const written = () => JSON.stringify({ diag: diag.events(), journal: env.noted });

describe("a database's words", () => {
  it("are on screen when it refuses a connection, and written nowhere", async () => {
    env.refuse = true;
    const id = await open("console");
    render(DbStatus, { docId: id, profile: null });
    expect(screen.getByTestId("db-status").textContent).toContain("LEAKMARK");
    expect(screen.getByTestId("db-status").textContent).toContain("42501");
    expect(written()).not.toContain("LEAKMARK");
  });

  it("are written nowhere by a failed statement, plan or catalog", async () => {
    const id = await open("console");
    await store.runSql(id, "SELECT 1");
    await store.planOf(id, "SELECT 1", false);
    expect(written()).not.toContain("LEAKMARK");
  });

  it("are no toast when a session would not stop: a toast is the journal, on disk", async () => {
    const id = await open("activity");
    render(DbActivityView, { sessionId: "silent", docId: id, visible: true, profile: null, serverName: "srv" });
    await settle();
    await fireEvent.click(screen.getByRole("button", { name: "End the session…" }));
    const buttons = screen.getAllByRole("button", { name: "End the session…" });
    await fireEvent.click(buttons[buttons.length - 1]);
    await settle();
    expect(env.noted.length).toBeGreaterThan(0);
    expect(written()).not.toContain("LEAKMARK");
    expect(written()).toContain("42501");
  });
});
