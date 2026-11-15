import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextFile } from "../types";

const server = vi.hoisted(() => ({
  files: {} as Record<string, string | Error>,
  reads: [] as [string, boolean][],
  writes: [] as unknown[][],
  failWrite: null as Error | null,
  /** Servers whose own sudo password does not work: a read through sudo asks for one. */
  sudoWants: new Set<string>(),
  /** Servers whose sudo will not, whatever the password. */
  sudoRefuses: new Set<string>(),
  checks: [] as [string, string | null, boolean][],
}));
vi.mock("../api", () => ({
  isFileChangedError: (e: unknown) => String(e).includes("file-changed"),
  annotateRecording: vi.fn(async () => {}),
  sftpReadText: vi.fn(async (id: string, _path: string, _max: number, sudo?: boolean) => {
    server.reads.push([id, !!sudo]);
    if (sudo && server.sudoRefuses.has(id)) throw "sudo-refused: not-allowed: Sorry, user deploy may not run sudo on db.";
    if (sudo && server.sudoWants.has(id)) throw "sudo-password: nothing";
    const f = server.files[id];
    if (f instanceof Error && !(sudo && f.message === "Permission denied")) throw f;
    const content = f instanceof Error ? "a\nb\nc\nd\ne\n" : f;
    const file: TextFile = {
      content,
      eol: "lf",
      size: content.length,
      mode: null,
      mtime: null,
      sha256: `sha-${id}`,
      readOnly: false,
      encoding: "windows-1251",
    };
    return file;
  }),
  sudoCheck: vi.fn(async (id: string, password: string | null, remember: boolean) => {
    server.checks.push([id, password, remember]);
    if (password !== "pw") throw "sudo-rejected: sudo did not accept the password";
    server.sudoWants.delete(id);
    return { via: "typed", rememberFailed: false };
  }),
  sftpWriteText: vi.fn(async (...args: unknown[]) => {
    if (server.failWrite) throw server.failWrite;
    server.writes.push(args);
    return {};
  }),
}));
vi.mock("../stores/recordings.svelte", () => ({ isRecording: () => false }));

import { createGroupEditFlow, type GroupEditDeps } from "./groupeditflow.svelte";
import { captureDiag } from "../api/diag";
import type { EditorDoc } from "../stores/workspaces.svelte";

const BASE = "a\nb\nc\nd\ne\n";
const EDITED = "a\nb\nC\nd\ne\n";
const doc = (over: Partial<EditorDoc> = {}) =>
  ({ id: "doc1", source: "sftp", path: "/etc/app.conf", name: "app.conf", baseContent: BASE, content: EDITED, ...over }) as EditorDoc;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("editing a file on the group", () => {
  let saved: boolean;
  let saves: number;
  let heard: ReturnType<typeof captureDiag>;
  const deps = (): GroupEditDeps => ({
    groupOf: () => ["lead", "web2", "web3", "db", "local"],
    isSsh: (id) => id !== "local",
    isProd: (id) => id === "db",
    label: (id) => `srv-${id}`,
    maxBytes: () => 1024,
    backup: () => true,
    saveLead: async () => {
      saves++;
      return saved;
    },
  });

  beforeEach(() => {
    server.files = { web2: BASE, web3: "x\ny\n", db: new Error("Permission denied") };
    server.reads = [];
    server.writes = [];
    server.failWrite = null;
    server.sudoWants.clear();
    server.sudoRefuses.clear();
    server.checks = [];
    saved = true;
    saves = 0;
    heard = captureDiag();
  });
  afterEach(() => heard.stop());

  it("reads every other server's copy and says how the edit lands on each", async () => {
    const flow = createGroupEditFlow(deps());
    expect(flow.servers("lead")).toBe(3);
    flow.open("lead", doc());
    expect(flow.ask?.hosts.map((h) => h.edit.kind)).toEqual(["reading", "reading", "reading"]);
    await settle();
    expect(flow.ask?.hosts.map((h) => [h.id, h.edit.kind, h.edit.kind === "patched" ? h.edit.outcome : null, h.picked])).toEqual([
      ["web2", "patched", "clean", true],
      ["web3", "patched", "conflict", false],
      ["db", "denied", null, false],
    ]);
  });

  it("reads again through sudo where it could not — the server's own sudo first — and writes there through sudo", async () => {
    const flow = createGroupEditFlow(deps());
    flow.open("lead", doc());
    await settle();
    flow.sudo("");
    await settle();
    expect(server.reads.at(-1)).toEqual(["db", true]);
    expect(server.checks).toEqual([]);
    const db = flow.ask?.hosts.find((h) => h.id === "db");
    expect(db?.edit).toMatchObject({ kind: "patched", outcome: "clean", sudo: true });
    expect(db?.picked).toBe(true);
    await flow.apply(doc());
    const dbWrite = server.writes.find((w) => w[0] === "db");
    expect(dbWrite?.[5]).toEqual({ sudo: true, backup: true, encoding: "windows-1251" });
  });

  it("the typed password goes only where the server's own does not work, and is not remembered", async () => {
    server.sudoWants.add("db");
    const flow = createGroupEditFlow(deps());
    flow.open("lead", doc());
    await settle();
    flow.sudo("");
    await settle();
    expect(flow.ask?.hosts.find((h) => h.id === "db")?.edit).toEqual({ kind: "denied", sudo: { kind: "password", tried: "nothing" } });
    flow.sudo("pw");
    await settle();
    expect(server.checks).toEqual([["db", "pw", false]]);
    expect(flow.ask?.hosts.find((h) => h.id === "db")?.edit).toMatchObject({ kind: "patched", sudo: true });
  });

  it("a server whose sudo will not is said on its row and not tried again", async () => {
    server.sudoRefuses.add("db");
    const flow = createGroupEditFlow(deps());
    flow.open("lead", doc());
    await settle();
    flow.sudo("pw");
    await settle();
    expect(flow.ask?.hosts.find((h) => h.id === "db")?.edit).toMatchObject({ kind: "denied", sudo: { kind: "refused", why: "not-allowed" } });
    const reads = server.reads.length;
    flow.sudo("pw");
    await settle();
    expect(server.reads.length).toBe(reads);
    expect(server.checks).toEqual([]);
  });

  it("saves the source first, then writes each ticked copy against the hash it was read with", async () => {
    const flow = createGroupEditFlow(deps());
    flow.open("lead", doc());
    await settle();
    await flow.apply(doc());
    expect(saves).toBe(1);
    expect(server.writes).toEqual([
      ["web2", "/etc/app.conf", EDITED, "lf", "sha-web2", { sudo: false, backup: true, encoding: "windows-1251" }],
    ]);
    expect(flow.ask?.done).toBe(true);
    expect(flow.ask?.hosts[0].edit).toEqual({ kind: "written" });
    expect(heard.events().at(-1)).toMatchObject({
      code: "group-edit",
      fields: { written: 1, failed: 0, already: 0, left: 2 },
    });
  });

  it("writes nothing else when the source could not be saved", async () => {
    saved = false;
    const flow = createGroupEditFlow(deps());
    flow.open("lead", doc());
    await settle();
    await flow.apply(doc());
    expect(server.writes).toEqual([]);
    expect(flow.ask?.leadFailed).toBe(true);
    expect(heard.events().at(-1)).toMatchObject({ level: "warn", code: "group-edit-stopped" });
  });

  it("does not overwrite a copy changed since it was read, and says so", async () => {
    server.failWrite = new Error("file-changed");
    const flow = createGroupEditFlow(deps());
    flow.open("lead", doc());
    await settle();
    await flow.apply(doc());
    expect(flow.ask?.hosts[0].edit).toMatchObject({ kind: "notWritten" });
    expect(heard.events().find((e) => e.code === "group-edit-not-written")).toMatchObject({ level: "warn", sid: "web2" });
  });

  it("offers nothing to carry when the edit is too large, and forgets a closed tab", () => {
    const flow = createGroupEditFlow(deps());
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n");
    flow.open("lead", doc({ baseContent: big, content: big.replace(/l/g, "L") }));
    expect(flow.ask?.hunks).toBeNull();
    expect(server.reads).toEqual([]);
    flow.forget("web3");
    expect(flow.ask).toBeNull();
  });
});
