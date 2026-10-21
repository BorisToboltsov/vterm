import { describe, expect, it } from "vitest";
import {
  asProto,
  isBlankRow,
  newRow,
  rowLine,
  rowRules,
  rowsText,
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
