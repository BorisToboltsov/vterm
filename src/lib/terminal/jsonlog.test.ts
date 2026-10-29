import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  parseLogLine,
  parseLogfmt,
  parseSyslog,
  parseNginx,
  parseDmesg,
  extractFields,
  toLogEntry,
  levelClass,
  levelCategory,
  availableFields,
  fieldValue,
  normalizeTime,
  filterEntries,
  applyFilters,
  colWidth,
  resizedWidth,
  COL_MIN,
  type JsonLogEntry,
} from "./jsonlog";

const ESC = "\u001b";

describe("stripAnsi", () => {
  it("removes colour escape sequences", () => {
    expect(stripAnsi(`${ESC}[31mERROR${ESC}[39m`)).toBe("ERROR");
  });
});

describe("parseLogLine", () => {
  it("parses a JSON object line", () => {
    expect(parseLogLine('{"a":1}')).toEqual({ a: 1 });
  });

  it("tolerates surrounding whitespace and ANSI colour", () => {
    expect(parseLogLine(`  ${ESC}[2m{"a":1}${ESC}[0m `)).toEqual({ a: 1 });
  });

  it("rejects non-JSON, arrays and primitives", () => {
    expect(parseLogLine("just a log line")).toBeNull();
    expect(parseLogLine("[1,2,3]")).toBeNull();
    expect(parseLogLine("42")).toBeNull();
    expect(parseLogLine("{broken")).toBeNull();
    expect(parseLogLine("")).toBeNull();
  });
});

describe("extractFields", () => {
  it("picks canonical field names", () => {
    expect(extractFields({ timestamp: "2026-01-01", level: "info", message: "hi" })).toEqual({
      ts: "2026-01-01",
      level: "info",
      message: "hi",
    });
  });

  it("tolerates alternative field names and coerces non-strings", () => {
    expect(extractFields({ ts: 1700000000, severity: 3, msg: "boom" })).toEqual({
      ts: "1700000000",
      level: "3",
      message: "boom",
    });
  });

  it("returns nulls when fields are absent or objects", () => {
    expect(extractFields({ foo: "bar", message: { nested: true } })).toEqual({
      ts: null,
      level: null,
      message: null,
    });
  });

  it("maps journald upper-case fields case-insensitively", () => {
    expect(
      extractFields({
        MESSAGE: "Connection closed",
        PRIORITY: "6",
        SYSLOG_TIMESTAMP: "Jun 24 11:25:24",
        __REALTIME_TIMESTAMP: "1782300324217609",
      }),
    ).toEqual({ ts: "Jun 24 11:25:24", level: "6", message: "Connection closed" });
  });
});

describe("parseLogfmt", () => {
  it("parses key=value pairs incl. quoted values", () => {
    expect(parseLogfmt('level=info msg="disk full" dur=1.2s')).toEqual({
      level: "info",
      msg: "disk full",
      dur: "1.2s",
    });
  });

  it("rejects a single pair or lines with free text", () => {
    expect(parseLogfmt("a=b")).toBeNull(); // needs >= 2 pairs
    expect(parseLogfmt("sshd[1]: foo=bar baz")).toBeNull(); // free text around
  });
});

describe("parseSyslog", () => {
  it("parses an RFC3164 line with pid", () => {
    expect(parseSyslog("Jun 24 11:25:24 host sshd[617]: Connection closed")).toEqual({
      timestamp: "Jun 24 11:25:24",
      host: "host",
      process: "sshd",
      pid: "617",
      message: "Connection closed",
    });
  });

  it("parses an ISO-timestamp variant without pid", () => {
    const r = parseSyslog("2026-06-24T11:25:24+00:00 host systemd: Started unit");
    expect(r).toMatchObject({ host: "host", process: "systemd", message: "Started unit" });
  });

  it("returns null for non-syslog text", () => {
    expect(parseSyslog("just some text")).toBeNull();
  });
});

describe("parseNginx", () => {
  it("parses a combined access log line with level from status", () => {
    const line =
      '203.0.113.5 - - [10/Oct/2000:13:55:36 -0700] "GET /index.html HTTP/1.1" 500 1234 "-" "curl/8"';
    expect(parseNginx(line)).toMatchObject({
      ip: "203.0.113.5",
      method: "GET",
      path: "/index.html",
      status: "500",
      level: "error",
      useragent: "curl/8",
    });
  });

  it("marks 4xx as warn and leaves 2xx without a level", () => {
    const mk = (code: number) =>
      parseNginx(`1.2.3.4 - - [x] "GET / HTTP/1.1" ${code} 1`)?.level;
    expect(mk(404)).toBe("warn");
    expect(mk(200)).toBeUndefined();
  });

  it("returns null for non-access-log text", () => {
    expect(parseNginx("nope")).toBeNull();
  });
});

describe("parseDmesg", () => {
  it("parses an uptime-prefixed kernel line", () => {
    expect(parseDmesg("[ 1234.567890] usb 1-1: new device")).toEqual({
      timestamp: "1234.567890",
      message: "usb 1-1: new device",
    });
  });

  it("returns null for a plain line", () => {
    expect(parseDmesg("no brackets here")).toBeNull();
  });
});

describe("toLogEntry", () => {
  it("detects JSON and records format + source", () => {
    expect(toLogEntry('{"level":"warn","msg":"x"}', 7)).toEqual({
      seq: 7,
      ts: null,
      level: "warn",
      message: "x",
      raw: { level: "warn", msg: "x" },
      format: "json",
      source: '{"level":"warn","msg":"x"}',
    });
  });

  it("detects logfmt", () => {
    const e = toLogEntry("level=error msg=boom", 1);
    expect(e?.format).toBe("logfmt");
    expect(e?.level).toBe("error");
    expect(e?.message).toBe("boom");
  });

  it("detects syslog", () => {
    const e = toLogEntry("Jun 24 11:25:24 host sshd[1]: hello", 2);
    expect(e?.format).toBe("syslog");
    expect(e?.message).toBe("hello");
  });

  it("returns null for plain text", () => {
    expect(toLogEntry("just a plain line", 1)).toBeNull();
  });
});

describe("normalizeTime", () => {
  it("formats epoch microseconds, ms and seconds", () => {
    // 2021-11-14T22:13:20Z = 1636928000 s
    expect(normalizeTime("1636928000000000")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(normalizeTime("1636928000000")).toMatch(/^\d{4}-/);
    expect(normalizeTime("1636928000")).toMatch(/^\d{4}-/);
  });

  it("formats an ISO timestamp", () => {
    expect(normalizeTime("2026-06-24T11:25:24Z")).toMatch(/^2026-06-24 \d{2}:\d{2}:\d{2}$/);
  });

  it("leaves kernel uptime and unparseable values unchanged", () => {
    expect(normalizeTime("1234.567")).toBe("1234.567");
    expect(normalizeTime("not a time")).toBe("not a time");
    expect(normalizeTime(null)).toBe("");
  });
});

describe("levelClass", () => {
  it("maps severities to colour classes", () => {
    expect(levelClass("ERROR")).toBe("text-danger");
    expect(levelClass("fatal")).toBe("text-danger");
    expect(levelClass("Warning")).toBe("text-warn");
    expect(levelClass("debug")).toBe("text-muted");
    expect(levelClass("info")).toBe("");
    expect(levelClass(null)).toBe("");
  });
});

describe("levelCategory", () => {
  it("classifies severities into broad buckets", () => {
    expect(levelCategory("FATAL")).toBe("error");
    expect(levelCategory("err")).toBe("error");
    expect(levelCategory("Warning")).toBe("warn");
    expect(levelCategory("INFO")).toBe("info");
    expect(levelCategory("notice")).toBe("info");
    expect(levelCategory("trace")).toBe("debug");
    expect(levelCategory("weird")).toBe("other");
    expect(levelCategory(null)).toBe("other");
  });

  it("maps numeric syslog priorities (journald PRIORITY)", () => {
    expect(levelCategory("0")).toBe("error"); // emerg
    expect(levelCategory("3")).toBe("error"); // err
    expect(levelCategory("4")).toBe("warn");
    expect(levelCategory("6")).toBe("info");
    expect(levelCategory("7")).toBe("debug");
  });
});

describe("availableFields", () => {
  it("returns the sorted union of raw keys", () => {
    const entries: JsonLogEntry[] = [
      { seq: 1, ts: null, level: null, message: null, raw: { b: 1, a: 2 }, format: "json", source: "" },
      { seq: 2, ts: null, level: null, message: null, raw: { a: 3, c: 4 }, format: "json", source: "" },
    ];
    expect(availableFields(entries)).toEqual(["a", "b", "c"]);
  });
});

describe("fieldValue", () => {
  const raw = { n: 5, s: "x", o: { k: 1 }, z: null };
  it("stringifies primitives, objects and blanks for null/missing", () => {
    expect(fieldValue(raw, "n")).toBe("5");
    expect(fieldValue(raw, "s")).toBe("x");
    expect(fieldValue(raw, "o")).toBe('{"k":1}');
    expect(fieldValue(raw, "z")).toBe("");
    expect(fieldValue(raw, "missing")).toBe("");
  });
});

describe("filterEntries", () => {
  const entries: JsonLogEntry[] = [
    { seq: 1, ts: "t1", level: "info", message: "started ok", raw: { a: 1 }, format: "json", source: "" },
    { seq: 2, ts: "t2", level: "error", message: "disk full", raw: { code: "ENOSPC" }, format: "json", source: "" },
  ];

  it("returns all on an empty query", () => {
    expect(filterEntries(entries, "  ")).toHaveLength(2);
  });

  it("matches level, message and raw JSON case-insensitively", () => {
    expect(filterEntries(entries, "ERROR").map((e) => e.seq)).toEqual([2]);
    expect(filterEntries(entries, "disk").map((e) => e.seq)).toEqual([2]);
    expect(filterEntries(entries, "enospc").map((e) => e.seq)).toEqual([2]);
    expect(filterEntries(entries, "started").map((e) => e.seq)).toEqual([1]);
  });
});

describe("applyFilters", () => {
  const entries: JsonLogEntry[] = [
    { seq: 1, ts: "t1", level: "info", message: "ok", raw: {}, format: "json", source: "" },
    { seq: 2, ts: "t2", level: "error", message: "boom", raw: {}, format: "json", source: "" },
    { seq: 3, ts: "t3", level: "warn", message: "careful", raw: {}, format: "json", source: "" },
  ];

  it("does no level filtering when all categories are enabled", () => {
    expect(applyFilters(entries, "", ["error", "warn", "info", "debug", "other"])).toHaveLength(3);
  });

  it("treats an empty level set as 'show all'", () => {
    expect(applyFilters(entries, "", [])).toHaveLength(3);
  });

  it("keeps only the enabled categories", () => {
    expect(applyFilters(entries, "", ["error"]).map((e) => e.seq)).toEqual([2]);
    expect(applyFilters(entries, "", ["error", "warn"]).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("combines the text query with the level filter", () => {
    expect(applyFilters(entries, "careful", ["warn"]).map((e) => e.seq)).toEqual([3]);
    expect(applyFilters(entries, "careful", ["error"])).toHaveLength(0);
  });
});

describe("colWidth", () => {
  it("returns the stored width when present and positive", () => {
    expect(colWidth({ time: 200 }, "time", 170)).toBe(200);
  });

  it("falls back when the key is missing or non-positive", () => {
    expect(colWidth({}, "time", 170)).toBe(170);
    expect(colWidth({ time: 0 }, "time", 170)).toBe(170);
    expect(colWidth({ time: -5 }, "time", 170)).toBe(170);
  });
});

describe("resizedWidth", () => {
  it("adds the signed delta to the start width and rounds", () => {
    expect(resizedWidth(170, 30.4)).toBe(200);
    expect(resizedWidth(170, -20.6)).toBe(149);
  });

  it("clamps to the minimum width", () => {
    expect(resizedWidth(80, -100)).toBe(COL_MIN);
    expect(resizedWidth(80, -100, 40)).toBe(40);
  });
});
