import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextFile } from "../types";

const server = vi.hoisted(() => ({
  files: {} as Record<string, string | Error>,
  reads: [] as [string, boolean, string | undefined][],
  writes: [] as unknown[][],
  failWrite: null as Error | null,
}));
vi.mock("../api", () => ({
  isFileChangedError: (e: unknown) => String(e).includes("file-changed"),
  annotateRecording: vi.fn(async () => {}),
  sftpReadText: vi.fn(async (id: string, _path: string, _max: number, sudo?: boolean, password?: string) => {
    server.reads.push([id, !!sudo, password]);
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

  it("reads again through sudo where it could not, and writes there through sudo", async () => {
    const flow = createGroupEditFlow(deps());
    flow.open("lead", doc());
    await settle();
    flow.sudo("pw");
    await settle();
    expect(server.reads.at(-1)).toEqual(["db", true, "pw"]);
    const db = flow.ask?.hosts.find((h) => h.id === "db");
    expect(db?.edit).toMatchObject({ kind: "patched", outcome: "clean", sudo: true });
    expect(db?.picked).toBe(true);
    await flow.apply(doc());
    const dbWrite = server.writes.find((w) => w[0] === "db");
    expect(dbWrite?.[5]).toMatchObject({ sudo: true, sudoPassword: "pw" });
  });

  it("saves the source first, then writes each ticked copy against the hash it was read with", async () => {
    const flow = createGroupEditFlow(deps());
    flow.open("lead", doc());
    await settle();
    await flow.apply(doc());
    expect(saves).toBe(1);
    expect(server.writes).toEqual([
      ["web2", "/etc/app.conf", EDITED, "lf", "sha-web2", { sudo: false, sudoPassword: undefined, backup: true, encoding: "windows-1251" }],
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
