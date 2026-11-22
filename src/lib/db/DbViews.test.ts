import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbOutcome, DbProfile, ServerProfile } from "../types";

// The database views over a mocked backend (ADR 0080): what a person clicks,
// and what is — and is not — sent for it.
const env = vi.hoisted(() => ({
  ran: [] as { sql: string; writable: boolean }[],
  refuse: null as null | string,
  saved: [] as unknown[],
  saveError: null as null | string,
}));

vi.mock("../api/db", () => {
  const answer = (over: object = {}) => ({ columns: [], rows: [], cut: [], truncated: false, affected: null, elapsedMs: 1, notices: [], error: null, read: true, tx: "none", backslashEscapes: false, ...over });
  return {
    dbLocalList: vi.fn(async () => []),
    dbSaveLocal: vi.fn(async (list: unknown) => {
      if (env.saveError) throw env.saveError;
      env.saved.push(list);
      return list;
    }),
    setServerDatabases: vi.fn(async (...a: unknown[]) => {
      env.saved.push(a);
      return {};
    }),
    dbForgetPassword: vi.fn(async () => {}),
    dbConnect: vi.fn(async () => ({ connId: "c", version: "16.6", readOnly: true, prod: true, kind: "postgres", rememberFailed: false })),
    dbQuery: vi.fn(async (_id: string, sql: string, _rows: number, writable: boolean) => {
      env.ran.push({ sql, writable });
      if (sql === env.refuse && !writable) throw "db-read-only: the statement needs read-only lifted";
      return answer(writable ? { read: false, affected: 1 } : {}) as DbOutcome;
    }),
    dbApply: vi.fn(async () => ({ changed: [], failure: null })),
    dbCancel: vi.fn(async () => {}),
    dbClose: vi.fn(async () => {}),
  };
});

import * as store from "../stores/db.svelte";
import { setLocale } from "../i18n";
import type { EditorDoc } from "../stores/workspaces.svelte";
import DbConsole from "./DbConsole.svelte";
import DbForm from "./DbForm.svelte";
import DbPanel from "./DbPanel.svelte";
import { kindOfImage, newProfile } from "./dbprofile";

const profile = (over: Partial<DbProfile> = {}): DbProfile => ({ ...newProfile("postgres", "d"), name: "billing", ...over });
const server = (databases: DbProfile[]): ServerProfile =>
  ({ id: "srv", alias: "db-prod-1", host: "10.0.0.5", port: 22, username: "ops", tags: [], prod: true, databases }) as unknown as ServerProfile;

let n = 0;
async function consoleWith(sql: string): Promise<void> {
  const id = `view-${++n}`;
  store.attachDb(id, { sessionId: "v", place: "srv", dbId: "d", kind: "postgres", view: "console" });
  await store.connectDb(id);
  await new Promise((r) => setTimeout(r, 30));
  env.ran.length = 0;
  const doc = { id, content: sql, db: { place: "srv", dbId: "d", kind: "postgres", view: "console" } } as unknown as EditorDoc;
  render(DbConsole, { sessionId: "v", doc, profile: profile(), serverName: "db-prod-1", onTerminal: () => {} });
  await fireEvent.click(screen.getByTestId("db-run"));
}

beforeEach(() => {
  setLocale("en");
  env.ran.length = 0;
  env.saved.length = 0;
  env.refuse = null;
  env.saveError = null;
});
afterEach(() => store.forgetDb("v"));

describe("console", () => {
  it("sends a write only after its question, and lifted for it", async () => {
    await consoleWith("UPDATE invoices SET a = 1 WHERE id = 1");
    await screen.findByText("UPDATE invoices SET a = 1 WHERE id = 1", { selector: "pre" });
    expect(env.ran).toEqual([]);
    await fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(env.ran).toEqual([{ sql: "UPDATE invoices SET a = 1 WHERE id = 1", writable: true }]));
  });

  it("sends nothing when the answer is no", async () => {
    await consoleWith("DELETE FROM invoices");
    await screen.findByText("DELETE FROM invoices", { selector: "pre" });
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(env.ran).toEqual([]);
  });

  it("asks when the backend saw a change, and only then sends it lifted", async () => {
    env.refuse = "SELECT app.archive()";
    await consoleWith("SELECT app.archive()");
    await screen.findByText("SELECT app.archive()", { selector: "pre" });
    expect(env.ran).toEqual([{ sql: "SELECT app.archive()", writable: false }]);
    await fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(env.ran.at(-1)).toEqual({ sql: "SELECT app.archive()", writable: true }));
  });

  it("runs a read without a question and shows it ran", async () => {
    await consoleWith("SELECT 1");
    await waitFor(() => expect(env.ran).toEqual([{ sql: "SELECT 1", writable: false }]));
  });
});

describe("form", () => {
  it("saves no database of this computer at another machine's address", async () => {
    const onclose = vi.fn();
    render(DbForm, { open: true, servers: [], initial: { place: null, profile: profile({ host: "10.0.0.9" }), editing: false }, onclose });
    await fireEvent.submit(await screen.findByTestId("db-form"));
    expect(env.saved).toEqual([]);
    expect(screen.getByText(/A database of this computer is at/)).toBeTruthy();
    await fireEvent.input(screen.getByTestId("db-form-host"), { target: { value: "127.0.0.1" } });
    await fireEvent.submit(screen.getByTestId("db-form"));
    await waitFor(() => expect(onclose).toHaveBeenCalled());
    expect(env.saved).toHaveLength(1);
  });

  it("stays open when the profile was not kept", async () => {
    env.saveError = "db-bad-profile: x";
    const onclose = vi.fn();
    render(DbForm, { open: true, servers: [], initial: { place: null, profile: profile(), editing: false }, onclose });
    await fireEvent.submit(await screen.findByTestId("db-form"));
    await new Promise((r) => setTimeout(r, 20));
    expect(onclose).not.toHaveBeenCalled();
  });
});

describe("panel", () => {
  it("lists a server's databases and opens a console", async () => {
    const onOpen = vi.fn();
    render(DbPanel, { servers: [server([profile({ name: "ledger" })])], connected: new Set(["srv"]), onOpen, onTerminal: () => {} });
    // The form's test left one at this computer: the server's is the last.
    const row = screen.getByText("ledger").closest('[data-testid="db-row"]') as HTMLElement;
    expect(row.textContent).toContain("RO");
    await fireEvent.click(row.querySelector('button[aria-label="Open console"]') as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith("srv", expect.objectContaining({ id: "d" }), "console");
  });

  it("opens the form it was asked for once, not again when mounted again", async () => {
    store.askNewDb("srv", profile({ id: "new", name: "found" }));
    const first = render(DbPanel, { servers: [server([])], connected: new Set<string>(), onOpen: () => {}, onTerminal: () => {} });
    expect(await screen.findByTestId("db-form")).toBeTruthy();
    first.unmount();
    render(DbPanel, { servers: [server([])], connected: new Set<string>(), onOpen: () => {}, onTerminal: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("db-form")).toBeNull();
  });

  it("takes for a database its image alone, not what stands beside it", () => {
    expect(kindOfImage("registry.local:5000/library/postgres:16")).toBe("postgres");
    expect(kindOfImage("mysql/mysql-server:8.0")).toBe("mysql");
    for (const image of ["prometheuscommunity/postgres-exporter", "prom/mysqld-exporter", "postgrest/postgrest", "percona/percona-toolkit", "mysql/mysql-router"])
      expect(kindOfImage(image), image).toBeNull();
  });
});
