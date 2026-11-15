import { describe, expect, it } from "vitest";
import type { ServerProfile } from "../types";
import {
  catalogInventory,
  expandRange,
  inventoryName,
  matchInventory,
  matchServer,
  parseIniInventory,
  parseInventoryJson,
} from "./inventory";

function server(p: Partial<ServerProfile>): ServerProfile {
  return {
    id: p.alias ?? "x",
    alias: "x",
    host: "10.0.0.1",
    port: 22,
    username: "deploy",
    authMethod: "key",
    keyPath: null,
    hasSavedPassword: false,
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
    ...p,
  };
}

describe("the inventory as Ansible sees it", () => {
  const json = JSON.stringify({
    _meta: { hostvars: { "web-1": { ansible_host: "10.0.1.11" }, "db-1": { ansible_host: "10.0.2.5", ansible_port: "2222", ansible_user: "pg" } } },
    all: { children: ["ungrouped", "prod"] },
    prod: { children: ["web", "db"] },
    web: { hosts: ["web-1"] },
    db: { hosts: ["db-1"] },
    ungrouped: { hosts: ["lonely"] },
    loop: { children: ["loop"] },
  });

  it("reads groups through their children and every host with where it connects", () => {
    const inv = parseInventoryJson(json)!;
    expect(inv.groups).toEqual([
      { name: "prod", hosts: ["web-1", "db-1"] },
      { name: "web", hosts: ["web-1"] },
      { name: "db", hosts: ["db-1"] },
      { name: "ungrouped", hosts: ["lonely"] },
    ]);
    expect(inv.hosts).toEqual([
      { name: "web-1", address: "10.0.1.11", port: null, user: null },
      { name: "db-1", address: "10.0.2.5", port: 2222, user: "pg" },
      { name: "lonely", address: "lonely", port: null, user: null },
    ]);
  });

  it("is null for what is not its answer", () => {
    expect(parseInventoryJson("not json")).toBeNull();
    expect(parseInventoryJson("[1]")).toBeNull();
    expect(parseInventoryJson("null")).toBeNull();
  });
});

describe("an INI inventory read by hand", () => {
  it("reads groups, children, vars and ranges", () => {
    const inv = parseIniInventory(`
lonely ansible_host=10.9.9.9
[web]
web[01:02] ansible_user=deploy
# a comment
[db]
db-1 ansible_host="10.0.2.5" ansible_port=2222 ; note
[db:vars]
ansible_user=pg
[prod:children]
web
db
`);
    expect(inv.groups.map((g) => [g.name, g.hosts])).toEqual([
      ["ungrouped", ["lonely"]],
      ["web", ["web01", "web02"]],
      ["db", ["db-1"]],
      ["prod", ["web01", "web02", "db-1"]],
    ]);
    expect(inv.hosts.find((h) => h.name === "db-1")).toEqual({ name: "db-1", address: "10.0.2.5", port: 2222, user: "pg" });
    expect(inv.hosts.find((h) => h.name === "web02")).toEqual({ name: "web02", address: "web02", port: null, user: "deploy" });
  });

  it("expands numeric and letter ranges, keeping the width", () => {
    expect(expandRange("web[08:10].x")).toEqual(["web08.x", "web09.x", "web10.x"]);
    expect(expandRange("db-[a:c]")).toEqual(["db-a", "db-b", "db-c"]);
    expect(expandRange("n[1:2]-[a:b]")).toEqual(["n1-a", "n1-b", "n2-a", "n2-b"]);
    expect(expandRange("odd[1:b]")).toEqual(["odd[1:b]"]);
    expect(expandRange("plain")).toEqual(["plain"]);
  });
});

describe("hosts and the catalog", () => {
  const servers = [
    server({ id: "w1", alias: "web-1", host: "10.0.1.11" }),
    server({ id: "d1", alias: "db-1", host: "10.0.2.5", port: 2222, username: "pg", prod: true }),
    server({ id: "d2", alias: "db-1-admin", host: "10.0.2.5", port: 2222, username: "root" }),
    server({ id: "c1", alias: "Cache", host: "cache.lan" }),
  ];

  it("matches by address and port, a shared address by user, else by alias", () => {
    expect(matchServer({ name: "w", address: "10.0.1.11", port: null, user: null }, servers)?.id).toBe("w1");
    expect(matchServer({ name: "d", address: "10.0.2.5", port: 2222, user: "root" }, servers)?.id).toBe("d2");
    expect(matchServer({ name: "d", address: "10.0.2.5", port: 2222, user: null }, servers)?.id).toBe("d1");
    expect(matchServer({ name: "cache", address: "10.7.7.7", port: null, user: null }, servers)?.id).toBe("c1");
    expect(matchServer({ name: "w", address: "10.0.1.11", port: 2200, user: null }, servers)).toBeNull();
    expect(matchServer({ name: "nobody", address: "1.1.1.1", port: null, user: null }, servers)).toBeNull();
  });

  it("knows prod whichever way the inventory wrote it", () => {
    const rows = matchInventory({ groups: [], hosts: [{ name: "db", address: "10.0.2.5", port: 2222, user: "pg" }] }, servers);
    expect(rows[0].prod).toBe(true);
  });
});

describe("servers of the catalog as an inventory", () => {
  const picked = [
    server({ id: "a", alias: "web 1", keyPath: "/home/me/.ssh/id_ed25519" }),
    server({ id: "b", alias: "web 1", authMethod: "password" }),
    server({
      id: "c",
      alias: "behind",
      host: "10.1.0.4",
      proxy: { kind: "jump", host: "jump.lan", port: 2200, username: "j", authMethod: "key", keyPath: "/k", hasSavedPassword: false },
    }),
    server({
      id: "d",
      alias: "agent",
      proxy: { kind: "jump", host: "jump.lan", port: 22, username: "j", authMethod: "key", keyPath: null, hasSavedPassword: false },
    }),
  ];

  it("writes address, port and user, unique names, and asks for passwords rather than writing them", () => {
    const inv = catalogInventory(picked, true);
    expect(inv.names).toEqual({ a: "web-1", b: "web-1-2", c: "behind", d: "agent" });
    expect(inv.asksPassword).toEqual(["b"]);
    expect(inv.text).toContain('        web-1:\n          ansible_host: "10.0.0.1"\n          ansible_port: 22\n          ansible_user: "deploy"');
    expect(inv.text).toContain('ansible_ssh_private_key_file: "/home/me/.ssh/id_ed25519"');
    expect(inv.text).toContain('ansible_ssh_common_args: "-o ProxyCommand=\\"ssh -i /k -p 2200 -W %h:%p j@jump.lan\\""');
    expect(inv.text).toContain('ansible_ssh_common_args: "-o ProxyJump=j@jump.lan:22"');
    expect(inv.text).not.toMatch(/password/i);
  });

  it("leaves this computer's paths out of a run on another host", () => {
    const inv = catalogInventory(picked, false);
    expect(inv.text).not.toContain("ansible_ssh_private_key_file");
    expect(inv.text).not.toContain("ansible_ssh_common_args");
  });

  it("names hosts in Ansible's characters", () => {
    expect(inventoryName("  prod / db #1 ")).toBe("prod-db-1");
    expect(inventoryName("***")).toBe("host");
  });
});
