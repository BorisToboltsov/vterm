import { describe, expect, it } from "vitest";
import { keyPathRows, loginRows, planImport, remapServers } from "./backupimport";
import type { ServerProfile, ServerProxy } from "../types";

const server = (id: string, over: Partial<ServerProfile> = {}): ServerProfile => ({
  id,
  alias: id,
  host: `${id}.example.net`,
  port: 22,
  username: "boris",
  authMethod: "key",
  keyPath: "/Users/boris/.ssh/id_ed25519",
  hasSavedPassword: true,
  group: null,
  tags: [],
  prod: false,
  autoRecord: false,
  noAi: false,
  chatPromptId: null,
  execMode: null,
  proxy: null,
  notes: "",
  icon: "",
  iconColor: "",
  ...over,
});

const jump = (over: Partial<ServerProxy> = {}): ServerProxy => ({
  kind: "jump",
  host: "bastion.example.net",
  port: 22,
  username: "boris",
  authMethod: "key",
  keyPath: "/Users/boris/.ssh/bastion",
  hasSavedPassword: true,
  ...over,
});

describe("loginRows / keyPathRows", () => {
  const servers = [
    server("a"),
    server("b", { proxy: jump() }),
    server("c", { username: "root", keyPath: null }),
    server("d", { username: "  ", keyPath: "" }),
  ];

  it("counts each login over servers and jump hosts, the most used first", () => {
    expect(loginRows(servers)).toEqual([
      { value: "boris", servers: 2, jumps: 1 },
      { value: "root", servers: 1, jumps: 0 },
    ]);
  });

  it("counts each key path; no path is not a path", () => {
    expect(keyPathRows(servers)).toEqual([
      { value: "/Users/boris/.ssh/id_ed25519", servers: 2, jumps: 0 },
      { value: "/Users/boris/.ssh/bastion", servers: 0, jumps: 1 },
    ]);
  });

  it("a backup without servers has nothing to change", () => {
    expect(loginRows([])).toEqual([]);
    expect(keyPathRows([])).toEqual([]);
  });
});

describe("remapServers", () => {
  it("replaces a login and a key path everywhere they are used, jump hosts too", () => {
    const [a, b] = remapServers(
      [server("a"), server("b", { proxy: jump() })],
      { boris: "  ivan  " },
      { "/Users/boris/.ssh/id_ed25519": "~/.ssh/id_ed25519", "/Users/boris/.ssh/bastion": "" },
      [],
    );
    expect(a.username).toBe("ivan");
    expect(a.keyPath).toBe("~/.ssh/id_ed25519");
    expect(b.proxy?.username).toBe("ivan");
    // An empty replacement leaves the value as it was.
    expect(b.proxy?.keyPath).toBe("/Users/boris/.ssh/bastion");
  });

  it("leaves a login with no replacement, and a missing key path missing", () => {
    const [c] = remapServers([server("c", { username: "root", keyPath: null })], { boris: "ivan" }, {}, []);
    expect(c.username).toBe("root");
    expect(c.keyPath).toBeNull();
  });

  it("says a password is saved only where this keychain has one for that id", () => {
    const current = [
      server("a", { hasSavedPassword: true, proxy: jump({ hasSavedPassword: true }) }),
      server("b", { hasSavedPassword: false }),
    ];
    const [a, b, c] = remapServers(
      [server("a", { proxy: jump() }), server("b"), server("c", { proxy: jump() })],
      {},
      {},
      current,
    );
    expect(a.hasSavedPassword).toBe(true);
    expect(a.proxy?.hasSavedPassword).toBe(true);
    expect(b.hasSavedPassword).toBe(false);
    expect(c.hasSavedPassword).toBe(false);
    expect(c.proxy?.hasSavedPassword).toBe(false);
  });

  it("does not change the backup it was given", () => {
    const incoming = [server("a")];
    remapServers(incoming, { boris: "ivan" }, {}, []);
    expect(incoming[0].username).toBe("boris");
    expect(incoming[0].hasSavedPassword).toBe(true);
  });
});

describe("planImport", () => {
  const mine = [server("m1", { host: "db.example.net", username: "ivan" }), server("m2")];

  it("replacing writes the backup's servers and folders and says what goes", () => {
    const plan = planImport("replace", mine, ["Mine"], [server("x")], ["Theirs"]);
    expect(plan.catalog.servers.map((s) => s.id)).toEqual(["x"]);
    expect(plan.catalog.folders).toEqual(["Theirs"]);
    expect(plan).toMatchObject({ added: 1, skipped: 0, removed: 2 });
  });

  it("adding keeps every current server and skips the ones already here", () => {
    const incoming = [
      server("m2"), // the same id
      server("x", { host: " DB.example.net ", username: "ivan" }), // the same place and login
      server("y", { host: "db.example.net", username: "root" }), // another login: a server of its own
      server("z", { host: "db.example.net", username: "ivan", port: 2222 }), // another port
    ];
    const plan = planImport("merge", mine, ["Mine", "Shared"], incoming, ["Shared", "Theirs"]);
    expect(plan.catalog.servers.map((s) => s.id)).toEqual(["m1", "m2", "y", "z"]);
    expect(plan.catalog.folders).toEqual(["Mine", "Shared", "Theirs"]);
    expect(plan).toMatchObject({ added: 2, skipped: 2, removed: 0 });
  });

  it("adding to an empty catalog is the backup itself", () => {
    const plan = planImport("merge", [], [], [server("x")], ["A"]);
    expect(plan.catalog).toEqual({ servers: [server("x")], folders: ["A"] });
    expect(plan.added).toBe(1);
  });
});
