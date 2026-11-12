import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../types";

const listings = vi.hoisted(() => ({ byId: {} as Record<string, FileEntry[] | Error> }));
vi.mock("../api", () => ({
  sftpList: vi.fn(async (id: string) => {
    const l = listings.byId[id];
    if (l instanceof Error) throw l;
    return l ?? [];
  }),
}));
const transfers = vi.hoisted(() => ({ started: [] as unknown[] }));
vi.mock("../files/transferflow", () => ({
  DISK: { session: null, local: true, label: "" },
  startTransfer: vi.fn(async (req: unknown) => {
    transfers.started.push(req);
    return "job";
  }),
}));

import { createGroupUploadFlow, type GroupUploadDeps } from "./groupuploadflow.svelte";
import { captureDiag } from "../api/diag";

const entry = (name: string, size = 10, modified: number | null = 1): FileEntry => ({
  name,
  path: `/etc/nginx/${name}`,
  isDir: false,
  isSymlink: false,
  size,
  modified,
  mode: null,
  uid: null,
  gid: null,
  user: null,
  group: null,
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const SRC = [{ path: "/home/me/app.conf", name: "app.conf", isDir: false }];

describe("upload to the group", () => {
  let group: string[] | null;
  let heard: ReturnType<typeof captureDiag>;
  const deps = (): GroupUploadDeps => ({
    groupOf: () => group,
    isSsh: (id) => id !== "local",
    isProd: (id) => id === "db",
    label: (id) => `srv-${id}`,
  });

  beforeEach(() => {
    group = ["web1", "web2", "db", "local"];
    listings.byId = {};
    transfers.started = [];
    heard = captureDiag();
  });
  afterEach(() => heard.stop());

  it("is not the group's when synchronous input is off, or the group has no other server", () => {
    group = null;
    expect(createGroupUploadFlow(deps()).upload("web1", "/etc", SRC)).toBe(false);
    group = ["web1", "local"];
    const flow = createGroupUploadFlow(deps());
    expect(flow.servers("web1")).toBeNull();
    expect(flow.upload("web1", "/etc", SRC)).toBe(false);
  });

  it("asks each server what the folder holds, its own first, and names the members it cannot send to", async () => {
    listings.byId = { web1: [], web2: [entry("app.conf", 2100)], db: new Error("No such file") };
    const flow = createGroupUploadFlow(deps());
    expect(flow.servers("web2")).toBe(3);
    expect(flow.upload("web2", "/etc/nginx", SRC)).toBe(true);
    expect(flow.ask?.hosts.map((h) => [h.label, h.check])).toEqual([
      ["srv-web2", null],
      ["srv-web1", null],
      ["srv-db", null],
    ]);
    await settle();
    expect(flow.ask?.outside).toEqual(["srv-local"]);
    expect(flow.ask?.hosts.map((h) => [h.id, h.check?.kind, h.picked, h.prod])).toEqual([
      ["web2", "ready", true, false],
      ["web1", "ready", true, false],
      ["db", "noFolder", false, true],
    ]);
  });

  it("keeps a taken name unless replacing was ticked, and starts one job per server", async () => {
    listings.byId = { web1: [], web2: [entry("app.conf")], db: [] };
    const flow = createGroupUploadFlow(deps());
    flow.upload("web1", "/etc/nginx", SRC);
    await settle();
    flow.toggle("db");
    await flow.confirm();
    expect(flow.ask).toBeNull();
    expect(transfers.started).toEqual([
      {
        src: { session: null, local: true, label: "" },
        dst: { session: "web1", local: false, label: "" },
        sources: [{ path: "/home/me/app.conf", isDir: false }],
        destDir: "/etc/nginx",
        agreed: false,
      },
    ]);
    expect(heard.events().map((e) => [e.code, e.fields])).toEqual([
      ["group-upload", { servers: 1, items: 1, replace: false }],
    ]);
  });

  it("replaces what is taken only on the answer of its own question", async () => {
    listings.byId = { web1: [], web2: [entry("app.conf")], db: [] };
    const flow = createGroupUploadFlow(deps());
    flow.upload("web1", "/etc/nginx", SRC);
    await settle();
    flow.setReplace(true);
    await flow.confirm();
    expect(transfers.started.map((r) => [(r as { dst: { session: string } }).dst.session, (r as { agreed: boolean }).agreed])).toEqual([
      ["web1", true],
      ["web2", true],
      ["db", true],
    ]);
  });

  it("lays the panel's folder beside the group's and names what only the others hold", async () => {
    listings.byId = {
      web1: [entry("app.conf", 10, 1)],
      web2: [entry("app.conf", 11, 1), entry("legacy.conf")],
      db: new Error("Permission denied"),
    };
    const flow = createGroupUploadFlow(deps());
    const done = flow.compare("web1", "/etc/nginx");
    expect(flow.compared("web1", "/etc/nginx")?.loading).toBe(true);
    await done;
    expect(flow.marks("web1", "/etc/nginx", entry("app.conf", 10, 1))).toEqual([
      { label: "srv-web2", mark: "differs" },
      { label: "srv-db", mark: "unknown" },
    ]);
    expect(flow.elsewhere("web1", "/etc/nginx")).toEqual([{ name: "legacy.conf", on: ["srv-web2"] }]);
    expect(flow.marks("web1", "/elsewhere", entry("app.conf"))).toBeNull();
    flow.forget("web1");
    expect(flow.compared("web1", "/etc/nginx")).toBeNull();
  });
});
