import { describe, expect, it } from "vitest";
import {
  buildTreeRows,
  dropAllowed,
  filterServers,
  groupOf,
  nameOf,
  parentOf,
  type TreeRow,
} from "./tree";
import type { ServerProfile } from "./types";

function srv(p: Partial<ServerProfile> & { id: string }): ServerProfile {
  return {
    alias: p.id,
    host: "example.com",
    port: 22,
    username: "root",
    authMethod: "password",
    keyPath: null,
    hasSavedPassword: false,
    group: null,
    tags: [],
    ...p,
  };
}

describe("parentOf / nameOf", () => {
  it("splits nested paths", () => {
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(nameOf("a/b/c")).toBe("c");
  });
  it("treats top-level paths as rooted", () => {
    expect(parentOf("top")).toBe("");
    expect(nameOf("top")).toBe("top");
  });
});

describe("groupOf", () => {
  it("trims and normalizes blank groups to root", () => {
    expect(groupOf(srv({ id: "a", group: "  Prod " }))).toBe("Prod");
    expect(groupOf(srv({ id: "b", group: "   " }))).toBe("");
    expect(groupOf(srv({ id: "c", group: null }))).toBe("");
  });
});

describe("filterServers", () => {
  const servers = [
    srv({ id: "1", alias: "Web EU", host: "10.0.0.1", tags: ["prod"] }),
    srv({ id: "2", alias: "DB", host: "db.internal", username: "pg", group: "Prod/DB" }),
  ];
  it("returns the same array for a blank query", () => {
    expect(filterServers(servers, "  ")).toBe(servers);
  });
  it("matches alias, host, username, group and tags (case-insensitive)", () => {
    expect(filterServers(servers, "web").map((s) => s.id)).toEqual(["1"]);
    expect(filterServers(servers, "db.internal").map((s) => s.id)).toEqual(["2"]);
    expect(filterServers(servers, "pg").map((s) => s.id)).toEqual(["2"]);
    expect(filterServers(servers, "prod").map((s) => s.id).sort()).toEqual(["1", "2"]);
  });
  it("returns nothing when no field matches", () => {
    expect(filterServers(servers, "zzz")).toEqual([]);
  });
});

describe("buildTreeRows", () => {
  it("flattens to filtered servers while searching (no folders)", () => {
    const servers = [srv({ id: "1", alias: "alpha" }), srv({ id: "2", alias: "beta" })];
    const rows = buildTreeRows({ servers, folders: [], search: "alpha", collapsed: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "server", depth: 0 });
  });

  it("nests folders and places servers under their group", () => {
    const servers = [
      srv({ id: "root", group: null }),
      srv({ id: "eu", group: "Prod/EU" }),
    ];
    const rows = buildTreeRows({
      servers,
      folders: ["Prod", "Prod/EU"],
      search: "",
      collapsed: [],
    });
    const kinds = rows.map((r) =>
      r.kind === "folder" ? `folder:${r.path}@${r.depth}` : `server:${r.server.id}@${r.depth}`,
    );
    // Prod (depth 0) → Prod/EU (depth 1) → server eu (depth 2) → root server last.
    expect(kinds).toEqual([
      "folder:Prod@0",
      "folder:Prod/EU@1",
      "server:eu@2",
      "server:root@0",
    ]);
  });

  it("synthesizes ancestor folders from a server group never created explicitly", () => {
    const servers = [srv({ id: "x", group: "A/B" })];
    const rows = buildTreeRows({ servers, folders: [], search: "", collapsed: [] });
    const folderPaths = rows.filter((r): r is Extract<TreeRow, { kind: "folder" }> => r.kind === "folder").map((r) => r.path);
    expect(folderPaths).toEqual(["A", "A/B"]);
  });

  it("counts servers in the whole subtree on each folder", () => {
    const servers = [
      srv({ id: "1", group: "Prod" }),
      srv({ id: "2", group: "Prod/EU" }),
      srv({ id: "3", group: "Prod/EU/web" }),
    ];
    const rows = buildTreeRows({
      servers,
      folders: ["Prod", "Prod/EU", "Prod/EU/web"],
      search: "",
      collapsed: [],
    });
    const prod = rows.find((r) => r.kind === "folder" && r.path === "Prod");
    expect(prod && prod.kind === "folder" && prod.count).toBe(3);
  });

  it("hides descendants of a collapsed folder", () => {
    const servers = [srv({ id: "eu", group: "Prod/EU" })];
    const rows = buildTreeRows({
      servers,
      folders: ["Prod", "Prod/EU"],
      search: "",
      collapsed: ["Prod"],
    });
    // Only the collapsed Prod folder shows; its subtree is omitted.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "folder", path: "Prod" });
  });
});

describe("dropAllowed", () => {
  it("rejects a null target", () => {
    expect(dropAllowed(null, "server", "1")).toBe(false);
  });
  it("allows a server onto any folder or root", () => {
    expect(dropAllowed("", "server", "1")).toBe(true);
    expect(dropAllowed("Prod", "server", "1")).toBe(true);
  });
  it("prevents a folder dropping on itself, a descendant, or its own parent", () => {
    expect(dropAllowed("Prod", "folder", "Prod")).toBe(false); // itself
    expect(dropAllowed("Prod/EU", "folder", "Prod")).toBe(false); // descendant
    expect(dropAllowed("Prod", "folder", "Prod/EU")).toBe(false); // current parent (no-op)
  });
  it("allows a folder onto an unrelated folder", () => {
    expect(dropAllowed("Staging", "folder", "Prod/EU")).toBe(true);
  });
});
