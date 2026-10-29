import { describe, expect, it } from "vitest";
import {
  buildHosts,
  buildMatrix,
  columnTally,
  hostKeyOf,
  LOCAL_KEY,
  planRun,
  routeRow,
  sourceHosts,
  subnetMisses,
  type HostFacts,
  type HostServer,
  type HostTab,
} from "./netroute";
import { MAX_CHECKS, parseRules, type NetReport, type PortStatus } from "./netcheck";

const servers: HostServer[] = [
  { id: "a1", alias: "app-01", host: "10.64.48.180", isProd: false },
  { id: "a2", alias: "app-02", host: "10.64.48.181", isProd: true },
  { id: "db", alias: "db", host: "db.int.corp", isProd: false },
  { id: "a1b", alias: "app-01 (deploy)", host: "10.64.48.180", isProd: false },
];
const tab = (sessionId: string, serverId: string, live = true, connecting = false): HostTab => ({
  sessionId,
  kind: serverId ? "ssh" : "local",
  serverId,
  live,
  connecting,
});

describe("buildHosts", () => {
  it("lists this machine when a local tab is open, then every server with its session", () => {
    const hosts = buildHosts(servers, [tab("L", ""), tab("s1", "a1"), tab("s2", "a2", false, true)]);
    expect(hosts.map((h) => [h.key, h.sessionId, h.live, h.connecting])).toEqual([
      [LOCAL_KEY, "L", true, false],
      ["10.64.48.180", "s1", true, false],
      ["10.64.48.181", "s2", false, true],
      ["db.int.corp", null, false, false],
    ]);
    expect(hosts[2].isProd).toBe(true);
    expect(buildHosts(servers, []).some((h) => h.key === LOCAL_KEY)).toBe(false);
  });

  it("prefers the tab the tool was opened on, then a live one", () => {
    const tabs = [tab("old", "a1", false), tab("live", "a1"), tab("home", "a1")];
    expect(buildHosts(servers, tabs, "home")[0].sessionId).toBe("home");
    expect(buildHosts(servers, tabs)[0].sessionId).toBe("live");
  });

  it("merges two profiles of one address, keeping the one with a session", () => {
    const hosts = buildHosts(servers, [tab("s9", "a1b")]);
    expect(hosts.filter((h) => h.key === "10.64.48.180")).toEqual([
      expect.objectContaining({ name: "app-01 (deploy)", sessionId: "s9" }),
    ]);
  });

  it("marks which servers have a tab — a chip each, one per address", () => {
    const hosts = buildHosts(servers, [tab("L", ""), tab("s1", "a1", false)]);
    expect(hosts.map((h) => [h.key, h.hasTab])).toEqual([
      [LOCAL_KEY, true],
      ["10.64.48.180", true],
      ["10.64.48.181", false],
      ["db.int.corp", false],
    ]);
    // A tab of the second profile of an address counts for the one chip.
    const merged = buildHosts(servers, [tab("s9", "a1b", false)]);
    expect(merged.filter((h) => h.key === "10.64.48.180").map((h) => h.hasTab)).toEqual([true]);
  });

  it("files a tab under its server's address", () => {
    expect(hostKeyOf(tab("s1", "a1"), servers)).toBe("10.64.48.180");
    expect(hostKeyOf(tab("L", ""), servers)).toBe(LOCAL_KEY);
  });
});

describe("sourceHosts", () => {
  const hosts = buildHosts(servers, [tab("s1", "a1"), tab("s2", "a2")]);
  const facts: Record<string, HostFacts> = {
    s1: { hostname: "app-01.int.corp", addrs: ["10.64.48.180", "10.64.49.7"] },
    s2: { hostname: "app-02", addrs: ["10.64.48.181"] },
  };
  const keys = (src: string) => sourceHosts(src, hosts, facts).map((m) => `${m.host.key}:${m.how}`);

  it("matches by name, address, a session's other address and hostname", () => {
    expect(keys("APP-01")).toEqual(["10.64.48.180:name"]);
    expect(keys("10.64.48.181")).toEqual(["10.64.48.181:address"]);
    expect(keys("10.64.49.7")).toEqual(["10.64.48.180:address"]);
    expect(keys("app-01.int.corp")).toEqual(["10.64.48.180:hostname"]);
    expect(keys("db.int.corp")).toEqual(["db.int.corp:address"]);
    expect(keys("10.9.9.9")).toEqual([]);
  });

  it("matches a subnet with every server inside it", () => {
    expect(keys("10.64.48.0/24")).toEqual(["10.64.48.180:subnet", "10.64.48.181:subnet"]);
    expect(keys("10.64.49.0/24")).toEqual(["10.64.48.180:subnet"]);
  });
});

describe("routing and the plan", () => {
  const hosts = buildHosts(servers, [tab("L", ""), tab("s1", "a1"), tab("s2", "a2")]);
  const facts: Record<string, HostFacts> = {};
  const rowOf = (line: string, via: string | null = null) => ({ rules: parseRules(line).rules, via });

  it("runs a rule without a source from the picked servers, a known source there, an unknown one picked — and says so", () => {
    expect(routeRow(rowOf("db:22"), hosts, facts, [LOCAL_KEY])).toEqual({ hosts: [LOCAL_KEY], how: "picked", unmatched: [] });
    expect(routeRow(rowOf("app-02 -> db:22"), hosts, facts, [LOCAL_KEY])).toEqual({
      hosts: ["10.64.48.181"],
      how: "source",
      unmatched: [],
    });
    expect(routeRow(rowOf("10.1.1.1 -> db:22"), hosts, facts, [LOCAL_KEY])).toEqual({
      hosts: [LOCAL_KEY],
      how: "fallback",
      unmatched: ["10.1.1.1"],
    });
    expect(routeRow(rowOf("10.1.1.1 -> db:22", "10.64.48.180"), hosts, facts, [LOCAL_KEY]).how).toBe("override");
  });

  it("checks a rule without a source from every picked server, and a sourced one only from its own", () => {
    const picked = [LOCAL_KEY, "10.64.48.180"];
    expect(routeRow(rowOf("db:22"), hosts, facts, picked).hosts).toEqual(picked);
    // Picking doesn't move a rule whose source names a server.
    expect(routeRow(rowOf("app-02 -> db:22"), hosts, facts, picked).hosts).toEqual(["10.64.48.181"]);
    const plan = planRun([rowOf("db:22"), rowOf("app-02 -> db:80")], hosts, facts, picked);
    expect(plan.ready.map((p) => [p.host.key, p.rules.map((r) => r.ports.join())])).toEqual([
      [LOCAL_KEY, ["22"]],
      ["10.64.48.180", ["22"]],
      ["10.64.48.181", ["80"]],
    ]);
    expect(plan.unrouted).toBe(0);
  });

  it("leaves a rule without a source unrouted when nothing is picked — and the plan counts it", () => {
    const route = routeRow(rowOf("db:22"), hosts, facts, []);
    expect(route).toEqual({ hosts: [], how: "picked", unmatched: [] });
    const unmatched = routeRow(rowOf("10.1.1.1 -> db:22"), hosts, facts, []);
    expect(unmatched).toEqual({ hosts: [], how: "fallback", unmatched: ["10.1.1.1"] });
    const plan = planRun([rowOf("db:22"), rowOf("app-02 -> db:80")], hosts, facts, []);
    expect(plan.unrouted).toBe(1);
    expect(plan.ready.map((p) => p.host.key)).toEqual(["10.64.48.181"]);
    // A picked key nobody knows (a server deleted since) goes nowhere either.
    expect(routeRow(rowOf("db:22"), hosts, facts, ["gone.corp"]).hosts).toEqual([]);
  });

  it("files each source's rule under its own server, not every server of the row", () => {
    const plan = planRun([rowOf("app-01, app-02 -> db:22"), rowOf("db:80")], hosts, facts, [LOCAL_KEY]);
    expect(plan.ready.map((p) => [p.host.key, p.rules.map((r) => `${r.source}:${r.ports}`), p.checks])).toEqual([
      ["10.64.48.180", ["app-01:22"], 1],
      ["10.64.48.181", ["app-02:22"], 1],
      [LOCAL_KEY, ["null:80"], 1],
    ]);
  });

  it("holds back servers without a live session and over the cap", () => {
    const plan = planRun(
      [rowOf("db -> x:22"), rowOf(`app-01 -> 10.0.0.0/24:1-8`), rowOf(`app-01 -> 10.0.1.0/24:1-8`)],
      hosts,
      facts,
      [LOCAL_KEY],
    );
    expect(plan.waiting.map((p) => p.host.key)).toEqual(["db.int.corp"]);
    expect(plan.overCap.map((p) => [p.host.key, p.checks])).toEqual([["10.64.48.180", 2 * 254 * 8]]);
    expect(2 * 254 * 8).toBeGreaterThan(MAX_CHECKS);
    expect(plan.ready).toEqual([]);
    expect(plan.overCap[0].subnet).toBe(true);
  });
});

describe("buildMatrix", () => {
  const rep = (results: [string, number, PortStatus, number | null][], over: Partial<NetReport> = {}): NetReport => ({
    hostname: "h",
    addrs: [],
    method: "bash",
    resolved: {},
    routeSrc: {},
    complete: true,
    tools: {},
    results: results.map(([host, port, status, ms]) => ({ host, port, status, ms, detail: status === "open" ? "" : "msg" })),
    ...over,
  });

  it("puts each server in its column and leaves what it wasn't asked empty", () => {
    const a = parseRules("10.64.48.180 -> 10.70.39.10:[5432, 6432] (pg)\n10.64.48.180 -> vault.int:8200").rules;
    const b = parseRules("10.64.48.181 -> 10.70.39.10:5432").rules;
    const cols = [
      {
        key: "a",
        rules: a,
        report: rep(
          [
            ["10.70.39.10", 5432, "open", 2],
            ["10.70.39.10", 6432, "refused", 1],
            ["vault.int", 8200, "timeout", null],
          ],
          { resolved: { "vault.int": "10.70.41.3" }, routeSrc: { "10.70.39.10": "10.64.48.180" }, addrs: ["10.64.48.180"] },
        ),
      },
      { key: "b", rules: b, report: rep([["10.70.39.10", 5432, "open", 3]]) },
    ];
    const m = buildMatrix(cols);
    expect(m.map((g) => [g.target, g.labels, g.rows.map((r) => r.port)])).toEqual([
      ["10.70.39.10", ["pg"], [5432, 6432]],
      ["vault.int", [], [8200]],
    ]);
    expect(m[0].rows[0].cells.map((c) => c?.status)).toEqual(["open", "open"]);
    expect(m[0].rows[1].cells.map((c) => c?.status ?? null)).toEqual(["refused", null]);
    expect(m[0].rows[0].cells[0]?.egress).toEqual({ src: "10.64.48.180", differs: false });
    expect(m[1].resolved).toEqual(["10.70.41.3", null]);
    expect(m[0].rows[0].service).toBe("postgres");
    expect(columnTally(cols[0])).toEqual({ open: 1, checked: 3 });
  });

  it("flags egress that leaves a subnet source", () => {
    const rules = parseRules("10.64.48.0/24 -> 10.70.40.15:443").rules;
    const m = buildMatrix([
      {
        key: "b",
        rules,
        report: rep([["10.70.40.15", 443, "timeout", null]], {
          addrs: ["10.64.48.181", "10.64.49.7"],
          routeSrc: { "10.70.40.15": "10.64.49.7" },
        }),
      },
    ]);
    expect(m[0].rows[0].cells[0]?.egress).toEqual({ src: "10.64.49.7", differs: true });
  });

  it("sums a subnet per port: who opened, how many of the rest did what", () => {
    const rules = parseRules("192.168.0.0/29:22").rules;
    const col = {
      key: "a",
      rules,
      report: rep([
        ["192.168.0.2", 22, "open", 3],
        ["192.168.0.3", 22, "refused", 1],
        ["192.168.0.4", 22, "timeout", null],
      ]),
    };
    const g = buildMatrix([col])[0];
    expect(g.isSubnet).toBe(true);
    expect(g.rows[0].cells).toEqual([null]);
    expect(g.rows[0].subnet?.[0]).toEqual({
      open: [{ host: "192.168.0.2", ms: 3 }],
      counts: { refused: 1, timeout: 1, missing: 3 },
      total: 6,
    });
    expect(subnetMisses(col, "192.168.0.0/29", 22).map((r) => `${r.host}:${r.status}`)).toEqual([
      "192.168.0.1:missing",
      "192.168.0.3:refused",
      "192.168.0.4:timeout",
      "192.168.0.5:missing",
      "192.168.0.6:missing",
    ]);
    expect(subnetMisses(col, "10.0.0.0/24", 22)).toEqual([]);
  });

  it("shows a stopped or failed server as unanswered, not as closed", () => {
    const rules = parseRules("db:22").rules;
    const g = buildMatrix([{ key: "a", rules, report: null }])[0];
    expect(g.rows[0].cells[0]?.status).toBe("missing");
  });
});
