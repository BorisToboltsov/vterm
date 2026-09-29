import { describe, it, expect } from "vitest";
import {
  parseRules,
  checkTargets,
  checkKey,
  netcheckArgs,
  runBudgetSecs,
  classifyAttempt,
  elapsedMs,
  coarseElapsedMs,
  parseNetReport,
  mergeReports,
  failedKeys,
  sourceMatch,
  egressDiffers,
  rowsFor,
  serviceName,
  tally,
  formatReport,
  pushHistory,
  sanitizeHistory,
  historyLabel,
  isIpv4,
  visibleAddrs,
  MAX_CHECKS,
  BATCH,
  HISTORY_MAX,
  HISTORY_HOSTS_MAX,
  type NetReport,
  type PortStatus,
} from "./netcheck";

const report = (over: Partial<NetReport> = {}): NetReport => ({
  hostname: "app-01",
  addrs: ["10.64.48.180", "172.17.0.1"],
  method: "bash",
  resolved: {},
  routeSrc: {},
  results: [],
  complete: true,
  ...over,
});

describe("parseRules", () => {
  it("parses the canonical firewall-request line", () => {
    const { rules, errors } = parseRules(
      "10.64.48.180 -> 10.70.39.10:[22, 80, 443, 8888, 3000, 9000, 9090, 3100]/tcp",
    );
    expect(errors).toEqual([]);
    expect(rules).toEqual([
      {
        line: 1,
        source: "10.64.48.180",
        targets: ["10.70.39.10"],
        ports: [22, 80, 443, 8888, 3000, 9000, 9090, 3100],
        proto: "tcp",
      },
    ]);
  });

  it("accepts several targets, ranges, other arrows and no source", () => {
    const { rules, errors } = parseRules(
      [
        "a => [10.0.0.1, db.internal]:[5432, 8000-8002]",
        "10.0.0.2, 10.0.0.3 : 22",
        "→ nope",
        "srv.local:53/udp",
        "10.0.0.9 → 10.0.0.1:80,443",
      ].join("\n"),
    );
    expect(rules[0]).toMatchObject({
      source: "a",
      targets: ["10.0.0.1", "db.internal"],
      ports: [5432, 8000, 8001, 8002],
      proto: "tcp",
    });
    expect(rules[1]).toMatchObject({ source: null, targets: ["10.0.0.2", "10.0.0.3"], ports: [22] });
    expect(rules[2]).toMatchObject({ source: null, targets: ["srv.local"], ports: [53], proto: "udp" });
    expect(rules[3]).toMatchObject({ source: "10.0.0.9", ports: [80, 443] });
    expect(errors.map((e) => e.line)).toEqual([3]);
  });

  it("skips blanks and comments, dedupes, keeps line numbers", () => {
    const { rules } = parseRules("\n# header\n  h:[22, 22, 80] # trailing\n");
    expect(rules).toEqual([{ line: 3, source: null, targets: ["h"], ports: [22, 80], proto: "tcp" }]);
  });

  it("reports each broken line with a code and keeps the good ones", () => {
    const { rules, errors } = parseRules(
      [
        "a -> b -> c:22", // two arrows
        "10.70.39.300:22", // not an IPv4
        "h:[0]", // port 0
        "h:70000",
        "h:[90-80]", // reversed range
        "h:[]",
        "-> h:22", // empty source
        "bad_host:22",
        "no port here",
        "ok:22",
      ].join("\n"),
    );
    expect(rules.map((r) => r.line)).toEqual([10]);
    expect(errors.map((e) => [e.line, e.code])).toEqual([
      [1, "syntax"],
      [2, "host"],
      [3, "port"],
      [4, "port"],
      [5, "range"],
      [6, "empty"],
      [7, "host"],
      [8, "host"],
      [9, "syntax"],
    ]);
  });

  it("caps a run so a typo can't become a port scan", () => {
    const { rules, errors } = parseRules("h:1-65535\nh2:22");
    expect(rules.map((r) => r.line)).toEqual([2]);
    expect(errors).toEqual([{ line: 1, code: "tooMany", token: String(MAX_CHECKS) }]);
    // UDP rows are never connected, so they don't count against the cap.
    expect(parseRules(`h:1-${MAX_CHECKS}/tcp\nh:1-2000/udp`).errors).toEqual([]);
  });

  it("isIpv4 is strict", () => {
    expect(isIpv4("10.0.0.1")).toBe(true);
    expect(isIpv4("10.0.0.256")).toBe(false);
    expect(isIpv4("host")).toBe(false);
  });
});

describe("checkTargets", () => {
  const { rules } = parseRules("s -> h1:[22,80]\nh1:[80,443]\nh2:53/udp\nh2:[5432]");

  it("merges TCP rules into unique host → ports, skipping UDP", () => {
    expect(checkTargets(rules)).toEqual([
      { host: "h1", ports: [22, 80, 443] },
      { host: "h2", ports: [5432] },
    ]);
  });

  it("restricts to a retry set", () => {
    expect(checkTargets(rules, new Set([checkKey("h1", 80)]))).toEqual([{ host: "h1", ports: [80] }]);
  });
});

describe("netcheckArgs", () => {
  it("is a single sh -c token ending in the completion marker", () => {
    const args = netcheckArgs([{ host: "10.0.0.1", ports: [22] }]);
    expect(args.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(args).toHaveLength(3);
    expect(args[2].trimEnd().endsWith("printf 'E\\n'")).toBe(true);
    expect(args[2]).toContain("chk 10.0.0.1 22 &");
    expect(args[2]).toContain("res 10.0.0.1");
  });

  it("identity probe has no checks", () => {
    const script = netcheckArgs([])[2];
    expect(script).not.toContain("chk ");
    expect(script).toContain("printf 'M\\t%s\\n'");
  });

  it("prefers bash /dev/tcp, then nc, then telnet", () => {
    const s = netcheckArgs([])[2];
    expect(s.indexOf("M=bash")).toBeLessThan(s.indexOf("M=nc"));
    expect(s.indexOf("M=nc")).toBeLessThan(s.indexOf("M=telnet"));
  });

  it("waits between batches", () => {
    const ports = Array.from({ length: BATCH + 1 }, (_, i) => i + 1);
    const s = netcheckArgs([{ host: "h", ports }])[2];
    expect(s.match(/^wait$/gm)).toHaveLength(2);
  });

  it("clamps the timeout and quotes hosts", () => {
    expect(netcheckArgs([], 999)[2]).toMatch(/^T=30$/m);
    expect(netcheckArgs([], 0)[2]).toMatch(/^T=1$/m);
    // Validation keeps hostnames clean; quoting is the second line of defence.
    expect(netcheckArgs([{ host: "a b", ports: [1] }])[2]).toContain("chk 'a b' 1 &");
  });

  it("budgets every batch plus slack", () => {
    expect(runBudgetSecs(1, 3)).toBe(14);
    expect(runBudgetSecs(BATCH + 1, 3)).toBe(18);
  });
});

describe("classifyAttempt", () => {
  it("reads exit codes and messages of every method", () => {
    expect(classifyAttempt("bash", 0, "", 3, 3)).toBe("open");
    expect(classifyAttempt("bash", 1, "bash: connect: Connection refused", 2, 3)).toBe("refused");
    expect(classifyAttempt("bash", 124, "", 3000, 3)).toBe("timeout");
    expect(classifyAttempt("bash", 1, "bash: connect: No route to host", 5, 3)).toBe("unreachable");
    expect(
      classifyAttempt("bash", 1, "bash: db: Name or service not known", 5, 3),
    ).toBe("dns");
    expect(classifyAttempt("nc", 0, "Connection to h 22 port [tcp/ssh] succeeded!", 3, 3)).toBe("open");
    expect(classifyAttempt("nc", 1, "Ncat: TIMEOUT.", 3000, 3)).toBe("timeout");
    // Silent nc on -w expiry: the elapsed time gives it away.
    expect(classifyAttempt("nc", 1, "", 2990, 3)).toBe("timeout");
    // busybox nc: silent and instant = the port answered with a reset.
    expect(classifyAttempt("nc", 1, "", 10, 3)).toBe("refused");
    expect(classifyAttempt("nc", 1, "", 2000, 3)).toBe("error");
    expect(classifyAttempt("bash", 1, "", 10, 3)).toBe("error");
    expect(classifyAttempt("nc", 1, "", null, 3)).toBe("error");
    // telnet exits 0/1 regardless; only "Connected to" means open.
    expect(classifyAttempt("telnet", 1, "Trying 1.2.3.4... Connected to h. Escape character is '^]'.", 5, 3)).toBe("open");
    expect(classifyAttempt("telnet", 0, "telnet: Unable to connect to remote host: Connection refused", 5, 3)).toBe("refused");
  });
});

describe("elapsedMs", () => {
  it("subtracts nanosecond epochs without losing precision", () => {
    expect(elapsedMs("1700000000123456789", "1700000000126456789")).toBe(3);
  });
  it("coarse seconds serve classification only", () => {
    expect(coarseElapsedMs("1790693025", "1790693027")).toBe(2000);
    expect(coarseElapsedMs("1790693027", "1790693025")).toBeNull();
    expect(coarseElapsedMs("1700000000123456789", "1700000000123456789")).toBeNull();
  });
  it("is null for non-readings (busybox date without %N) and negatives", () => {
    expect(elapsedMs("1700000000N", "1700000001N")).toBeNull();
    expect(elapsedMs("", "")).toBeNull();
    expect(elapsedMs("1700000000200000000", "1700000000100000000")).toBeNull();
  });
});

describe("parseNetReport", () => {
  it("parses the remote protocol", () => {
    const out = [
      "H\tapp-01",
      "A\t127.0.0.1/8",
      "A\t10.64.48.180/24",
      "A\t10.64.48.180/24",
      "M\tbash",
      "D\tdb.internal\t10.70.39.20",
      "D\tgone.internal\t",
      "S\t10.70.39.10\t10.64.48.180",
      "R\t10.70.39.10\t22\t0\t1700000000000000000\t1700000000004000000\t",
      "R\t10.70.39.10\t8888\t1\t1700000000000000000\t1700000000002000000\tbash: connect: Connection refused",
      "R\t10.70.39.10\t9000\t1\t1790693025\t1790693025\t",
      "R\tbroken",
      "junk line",
      "E",
    ].join("\n");
    const rep = parseNetReport(out, 3);
    expect(rep.hostname).toBe("app-01");
    expect(rep.addrs).toEqual(["127.0.0.1", "10.64.48.180"]);
    expect(rep.method).toBe("bash");
    expect(rep.resolved).toEqual({ "db.internal": "10.70.39.20", "gone.internal": "" });
    expect(rep.routeSrc).toEqual({ "10.70.39.10": "10.64.48.180" });
    expect(rep.results).toEqual([
      { host: "10.70.39.10", port: 22, status: "open", ms: 4, detail: "" },
      {
        host: "10.70.39.10",
        port: 8888,
        status: "refused",
        ms: 2,
        detail: "bash: connect: Connection refused",
      },
      // busybox: whole-second clock, silent refusal — classified, ms unknown.
      { host: "10.70.39.10", port: 9000, status: "error", ms: null, detail: "" },
    ]);
    expect(rep.complete).toBe(true);
  });

  it("parses the native protocol and flags a cut-short run", () => {
    const rep = parseNetReport("H\tmac\nM\tnative\nN\th\t22\topen\t3\t\nN\th\t23\tweird\t\tboom\nN\th\tx\topen\t1\t");
    expect(rep.method).toBe("native");
    expect(rep.results).toEqual([
      { host: "h", port: 22, status: "open", ms: 3, detail: "" },
      { host: "h", port: 23, status: "error", ms: null, detail: "boom" },
    ]);
    expect(rep.complete).toBe(false);
  });

  it("ignores an unknown method", () => {
    expect(parseNetReport("M\tcurl\n").method).toBeNull();
  });
});

describe("source checks", () => {
  it("matches by address or hostname", () => {
    expect(sourceMatch(null, report())).toBe("none");
    expect(sourceMatch("10.64.48.180", report())).toBe("ok");
    expect(sourceMatch("APP-01", report())).toBe("ok");
    expect(sourceMatch("app-01", report({ hostname: "app-01.corp.local" }))).toBe("ok");
    expect(sourceMatch("10.64.48.181", report())).toBe("foreign");
    expect(sourceMatch("10.64.48.181", report({ addrs: [] }))).toBe("unknown");
  });

  it("flags an egress address different from the rule's own source", () => {
    const rep = report({ routeSrc: { t: "172.17.0.1" } });
    expect(egressDiffers("10.64.48.180", "t", rep)).toBe(true);
    expect(egressDiffers("172.17.0.1", "t", rep)).toBe(false);
    // Foreign or hostname sources are already warned about otherwise.
    expect(egressDiffers("10.9.9.9", "t", rep)).toBe(false);
    expect(egressDiffers("app-01", "t", rep)).toBe(false);
    expect(egressDiffers("10.64.48.180", "other", rep)).toBe(false);
    expect(egressDiffers(null, "t", rep)).toBe(false);
  });
});

describe("rows, retry and merge", () => {
  const { rules } = parseRules("h:[22,80,443]\nh:53/udp");
  const rep = report({
    results: [
      { host: "h", port: 22, status: "open", ms: 1, detail: "" },
      { host: "h", port: 80, status: "timeout", ms: 3000, detail: "" },
    ],
  });

  it("rowsFor keeps rule order, marks unanswered and UDP rows", () => {
    expect(rowsFor(rules[0], "h", rep).map((r) => r.status)).toEqual(["open", "timeout", "missing"]);
    expect(rowsFor(rules[1], "h", rep).map((r) => r.status)).toEqual(["udp"]);
    expect(rowsFor(rules[0], "h", null).map((r) => r.status)).toEqual(["missing", "missing", "missing"]);
  });

  it("tally ignores rows that weren't checked", () => {
    expect(tally(rowsFor(rules[0], "h", rep))).toEqual({ open: 1, checked: 2 });
    expect(tally(rowsFor(rules[1], "h", rep))).toEqual({ open: 0, checked: 0 });
  });

  it("failedKeys covers failures and unanswered TCP ports only", () => {
    expect([...failedKeys(rules, rep)]).toEqual(["h:80", "h:443"]);
  });

  it("mergeReports replaces retried ports in place", () => {
    const next = report({
      routeSrc: { h: "10.64.48.180" },
      results: [{ host: "h", port: 80, status: "open", ms: 2, detail: "" }],
    });
    const merged = mergeReports(rep, next);
    expect(merged.results.map((r) => `${r.port}:${r.status}`)).toEqual(["22:open", "80:open"]);
    expect(merged.routeSrc).toEqual({ h: "10.64.48.180" });
  });
});

describe("presentation", () => {
  it("knows common service ports", () => {
    expect(serviceName(22)).toBe("ssh");
    expect(serviceName(3100)).toBe("loki");
    expect(serviceName(12345)).toBe("");
  });

  it("formats a ticket-ready report", () => {
    const { rules } = parseRules("10.64.48.180 -> db:[5432,6379]\ndb:53/udp");
    const status = Object.fromEntries(
      (["open", "refused", "timeout", "unreachable", "dns", "error", "udp", "missing"] as PortStatus[]).map(
        (s) => [s, s.toUpperCase()],
      ),
    ) as Record<PortStatus, string>;
    const text = formatReport(
      rules,
      report({
        resolved: { db: "10.70.39.20" },
        results: [{ host: "db", port: 5432, status: "open", ms: 4, detail: "" }],
      }),
      { from: "From", ms: (n) => `${n} ms`, status },
    );
    expect(text).toBe(
      [
        "From: app-01 · 10.64.48.180, 172.17.0.1",
        "",
        "10.64.48.180 -> db (10.70.39.20) /tcp",
        "  5432  OPEN 4 ms  (postgres)",
        "  6379  MISSING  (redis)",
        "",
        "db (10.70.39.20) /udp",
        "  53    UDP  (dns)",
      ].join("\n"),
    );
  });
});

describe("history", () => {
  it("keeps newest first, deduped and capped per host", () => {
    let h = pushHistory({}, "srv", "a");
    h = pushHistory(h, "srv", "b");
    h = pushHistory(h, "srv", " a ");
    expect(h.srv).toEqual(["a", "b"]);
    for (let i = 0; i < HISTORY_MAX + 5; i++) h = pushHistory(h, "srv", `r${i}`);
    expect(h.srv).toHaveLength(HISTORY_MAX);
    expect(pushHistory(h, "srv", "   ")).toBe(h);
    expect(pushHistory(h, "", "x")).toBe(h);
  });

  it("forgets the least recently used host past the cap", () => {
    let h = {};
    for (let i = 0; i <= HISTORY_HOSTS_MAX; i++) h = pushHistory(h, `h${i}`, "x");
    expect(Object.keys(h)).toHaveLength(HISTORY_HOSTS_MAX);
    expect(h).not.toHaveProperty("h0");
  });

  it("sanitizes whatever comes out of storage", () => {
    expect(sanitizeHistory(null)).toEqual({});
    expect(sanitizeHistory([1])).toEqual({});
    expect(sanitizeHistory({ a: ["x", 1, " "], b: "nope", c: [] })).toEqual({ a: ["x"] });
  });

  it("labels an entry by its first line", () => {
    expect(historyLabel("\n a:22 \nb:80\nc:1")).toBe("a:22 (+2)");
    expect(historyLabel("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("visibleAddrs", () => {
  it("hides loopback and link-local", () => {
    expect(visibleAddrs(["127.0.0.1", "::1", "fe80::1", "10.0.0.5", "2001:db8::5"])).toEqual([
      "10.0.0.5",
      "2001:db8::5",
    ]);
  });
});
