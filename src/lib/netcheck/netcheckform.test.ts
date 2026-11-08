import { describe, expect, it } from "vitest";
import {
  asProto,
  isBlankRow,
  loadTables,
  newRow,
  rowLine,
  rowRules,
  rowsText,
  SAVED_ROWS_MAX,
  saveTables,
  sourceChoice,
  sourceOptions,
  splitHostPort,
  textRows,
  withSource,
} from "./netcheckform";
import { parseRules } from "./netcheck";

const row = (source: string, targets: string, ports: string, proto: "tcp" | "udp" = "tcp") =>
  newRow({ source, targets, ports, proto });

describe("rowLine", () => {
  it("writes one port bare and several in brackets, always with the protocol", () => {
    expect(rowLine(row("10.0.0.1", "db", "22"))).toBe("10.0.0.1 -> db:22/tcp");
    expect(rowLine(row("10.0.0.1", "db", "22, 443 8443"))).toBe("10.0.0.1 -> db:[22, 443, 8443]/tcp");
    expect(rowLine(row("", " db ", "53", "udp"))).toBe("db:53/udp");
  });

  it("keeps the notes in the cells, so the parser reads them as notes", () => {
    const { rules } = parseRules(rowLine(row("10.0.0.1 (gitlab)", "10.0.0.5 (vault)", "22, 8200")));
    expect(rules[0]).toMatchObject({ source: "10.0.0.1", sourceLabel: "gitlab", targets: ["10.0.0.5"], label: "vault" });
  });
});

describe("rowRules", () => {
  it("names the empty cell first, then whatever the parser rejects", () => {
    expect(rowRules(row("", "", "22")).error).toEqual({ code: "noTarget" });
    expect(rowRules(row("", "db", " ")).error).toEqual({ code: "noPorts" });
    expect(rowRules(row("", "10.70.39.300", "22")).error).toMatchObject({ code: "host", token: "10.70.39.300" });
    expect(rowRules(row("", "db", "nosuch")).error).toMatchObject({ code: "port", token: "nosuch" });
    expect(rowRules(row("", "0.0.0.0", "22")).error).toMatchObject({ code: "unspecified" });
  });

  it("gives a rule per source, subnets and service names included", () => {
    const { rules, error } = rowRules(row("app-01, app-02", "192.168.0.0/24", "ssh, 8080"));
    expect(error).toBeNull();
    expect(rules.map((r) => [r.source, r.targets, r.ports])).toEqual([
      ["app-01", ["192.168.0.0/24"], [22, 8080]],
      ["app-02", ["192.168.0.0/24"], [22, 8080]],
    ]);
  });
});

describe("rows as text", () => {
  it("writes the non-empty rows one per line and reads them back", () => {
    const rows = [row("10.0.0.1", "db", "5432"), newRow(), row("", "web.int", "80, 443")];
    const text = rowsText(rows);
    expect(text).toBe("10.0.0.1 -> db:5432/tcp\nweb.int:[80, 443]/tcp");
    const back = textRows(text);
    expect(back.map((r) => [r.source, r.targets, r.ports, r.proto])).toEqual([
      ["10.0.0.1", "db", "5432", "tcp"],
      ["", "web.int", "80, 443", "tcp"],
    ]);
  });

  it("gives every row its own id and knows a blank one", () => {
    expect(newRow().id).not.toBe(newRow().id);
    expect(isBlankRow(newRow())).toBe(true);
    expect(isBlankRow(row("", "", " 22"))).toBe(false);
    expect(asProto("udp")).toBe("udp");
    expect(asProto("anything")).toBe("tcp");
  });
});

describe("splitHostPort", () => {
  it("spreads host:port and host:[ports] over the two cells", () => {
    expect(splitHostPort("10.70.39.10:22")).toEqual({ target: "10.70.39.10", ports: "22" });
    expect(splitHostPort(" db.corp : [22, 443] ")).toEqual({ target: "db.corp", ports: "22, 443" });
    expect(splitHostPort("db:postgres")).toEqual({ target: "db", ports: "postgres" });
  });

  it("leaves a bare host or a half-typed colon alone", () => {
    expect(splitHostPort("10.70.39.10")).toBeNull();
    expect(splitHostPort("10.70.39.10:")).toBeNull();
    expect(splitHostPort("a -> b:22")).toBeNull();
  });
});

describe("the From cell", () => {
  const keys = ["local", "10.70.39.10", "10.64.48.180", "10.64.48.21"];
  const row = (source: string, via: string | null = null) => ({ source, via });

  it("shows all picked by default, a server picked by hand, or the source as written", () => {
    expect(sourceChoice(row(""), keys)).toEqual({ kind: "all" });
    expect(sourceChoice(row("  "), keys)).toEqual({ kind: "all" });
    expect(sourceChoice(row("", "10.70.39.10"), keys)).toEqual({ kind: "host", key: "10.70.39.10" });
    expect(sourceChoice(row("10.1.1.1"), keys)).toEqual({ kind: "text", text: "10.1.1.1" });
    // The server picked by hand is what checks — it's what the cell names.
    expect(sourceChoice(row("10.1.1.1", "local"), keys)).toEqual({ kind: "host", key: "local" });
    // A server the catalog no longer has counts for nothing, as in routing.
    expect(sourceChoice(row("", "gone.corp"), keys)).toEqual({ kind: "all" });
  });

  it("a choice sets one thing: a server replaces the address, an address drops the server", () => {
    expect(withSource({ kind: "all" })).toEqual({ source: "", via: null });
    expect(withSource({ kind: "host", key: "local" })).toEqual({ source: "", via: "local" });
    expect(withSource({ kind: "text", text: " 10.0.0.0/24 " })).toEqual({ source: "10.0.0.0/24", via: null });
  });

  it("offers the picked servers in host order, and the row's own server too", () => {
    const picked = ["10.64.48.21", "local", "gone.corp"];
    expect(sourceOptions(picked, keys, { kind: "all" })).toEqual(["local", "10.64.48.21"]);
    expect(sourceOptions(picked, keys, { kind: "host", key: "10.64.48.180" })).toEqual([
      "local",
      "10.64.48.21",
      "10.64.48.180",
    ]);
    expect(sourceOptions([], keys, { kind: "text", text: "x" })).toEqual([]);
  });
});

describe("saveTables / loadTables", () => {
  const row = (targets: string, ports: string, via: string | null = null) => newRow({ targets, ports }, via);

  it("keeps the rows as typed and the servers picked, per home host", () => {
    const saved = saveTables({
      rows: { "10.0.0.5": [row("db", "5432", "local"), newRow()], local: [newRow()] },
      picked: { "10.0.0.5": ["local", "10.0.0.5"], local: [] },
    });
    // Blank rows and ids are not kept; a home with nothing typed is not kept.
    expect(saved).toEqual({
      rows: { "10.0.0.5": [{ source: "", targets: "db", ports: "5432", proto: "tcp", via: "local" }] },
      picked: { "10.0.0.5": ["local", "10.0.0.5"], local: [] },
    });
    const back = loadTables(JSON.parse(JSON.stringify(saved)));
    expect(back.rows["10.0.0.5"].map(({ id: _id, ...r }) => r)).toEqual(saved.rows["10.0.0.5"]);
    expect(back.rows["10.0.0.5"][0].id).toMatch(/^r/);
    // Picking nothing is a choice too: not the home host by default.
    expect(back.picked).toEqual({ "10.0.0.5": ["local", "10.0.0.5"], local: [] });
  });

  it("drops what does not read as a row instead of guessing", () => {
    const back = loadTables({
      rows: {
        h: [
          { source: "", targets: "a", ports: "22", proto: "tcp", via: null },
          { source: "", targets: "b", ports: 22, proto: "tcp", via: null },
          { source: "", targets: "c", ports: "22", proto: "icmp", via: null },
          { source: "", targets: "d", ports: "22", proto: "udp", via: "" },
          { source: "", targets: "", ports: "", proto: "tcp", via: null },
          "e:22",
          null,
        ],
        "": [{ source: "", targets: "x", ports: "1", proto: "tcp", via: null }],
        k: "nope",
      },
      picked: { h: ["a", 1, "", "a"], j: "x" },
    });
    expect(back.rows.h.map((r) => r.targets)).toEqual(["a"]);
    expect(Object.keys(back.rows)).toEqual(["h"]);
    expect(back.picked).toEqual({ h: ["a"] });
  });

  it("reads nothing from what is not a stored table", () => {
    for (const raw of [null, undefined, 1, "x", [], { rows: [], picked: [] }]) {
      expect(loadTables(raw)).toEqual({ rows: {}, picked: {} });
    }
  });

  it("keeps a long table's first rows", () => {
    const rows = Array.from({ length: SAVED_ROWS_MAX + 5 }, (_, i) => row(`h${i}`, "22"));
    const saved = saveTables({ rows: { h: rows }, picked: {} });
    expect(saved.rows.h).toHaveLength(SAVED_ROWS_MAX);
    expect(saved.rows.h[0].targets).toBe("h0");
  });
});

describe("IPv6 in the table (v1.35)", () => {
  it("a target list with an IPv6 address goes in brackets, so the rule reads back", () => {
    const row = newRow({ targets: "2001:db8::1, 10.0.0.1", ports: "443" });
    expect(rowLine(row)).toBe("[2001:db8::1, 10.0.0.1]:443/tcp");
    expect(rowRules(row).error).toBeNull();
    expect(rowRules(row).rules[0].targets).toEqual(["2001:db8::1", "10.0.0.1"]);
    expect(rowLine(newRow({ targets: "[::1]", ports: "22" }))).toBe("[::1]:22/tcp");
  });

  it("splits a typed `[addr]:port` across the two cells", () => {
    expect(splitHostPort("[2001:db8::1]:443")).toEqual({ target: "2001:db8::1", ports: "443" });
    expect(splitHostPort("2001:db8::1")).toBeNull();
  });
});
