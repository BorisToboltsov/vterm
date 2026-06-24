// Pure helpers for the structured log view (ADR 0003 — testable, no DOM).
//
// Despite the file name, this parses several common structured log formats, not
// just JSON: per line it auto-detects JSON (NDJSON), logfmt (key=value), syslog
// (RFC 3164/5424), nginx/apache access logs and the kernel ring buffer (dmesg).
// Each is normalised into a common entry (timestamp/level/message + a field map
// for the dynamic columns), so the same table renders all of them. The Terminal
// feeds it complete output lines; JsonLogView renders the result.

/** Which structured format a line was recognised as. */
export type LogFormat = "json" | "logfmt" | "syslog" | "nginx" | "dmesg";

/** One recognised structured log line. `raw` is the field map; `source` the original line. */
export interface JsonLogEntry {
  seq: number;
  ts: string | null;
  level: string | null;
  message: string | null;
  raw: Record<string, unknown>;
  format: LogFormat;
  source: string;
}

// CSI / OSC escape sequences — stripped before parsing (logs may be colourised).
const ESC_SEQ = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Remove ANSI escape sequences from a line. */
export function stripAnsi(line: string): string {
  return line.replace(ESC_SEQ, "");
}

/**
 * Parse a single line as a JSON object, or return null. Cheap-rejects anything
 * that isn't an object literal before calling JSON.parse, so non-JSON output
 * (the common case) costs almost nothing.
 */
export function parseLogLine(line: string): Record<string, unknown> | null {
  const s = stripAnsi(line).trim();
  if (s.length < 2 || s[0] !== "{" || s[s.length - 1] !== "}") return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// Field-name conventions (lower-case), in priority order. Includes systemd
// journal keys (`MESSAGE`, `PRIORITY`, `SYSLOG_TIMESTAMP`, `__REALTIME_TIMESTAMP`)
// so `journalctl -o json` maps onto the columns out of the box.
const TS_KEYS = [
  "timestamp",
  "time",
  "ts",
  "@timestamp",
  "datetime",
  "date",
  "t",
  "syslog_timestamp",
  "__realtime_timestamp",
];
const LEVEL_KEYS = ["level", "lvl", "severity", "levelname", "loglevel", "log_level", "priority"];
const MSG_KEYS = ["message", "msg", "text", "event", "log", "description"];

function pick(lower: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = lower[k];
    if (v !== undefined && v !== null && typeof v !== "object") return String(v);
  }
  return null;
}

/**
 * Extract the display timestamp/level/message from a parsed object. Key lookup
 * is **case-insensitive** so upper-case conventions (journald) work too.
 */
export function extractFields(obj: Record<string, unknown>): {
  ts: string | null;
  level: string | null;
  message: string | null;
} {
  const lower: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase();
    if (!(lk in lower)) lower[lk] = obj[k]; // first key wins on a case collision
  }
  return {
    ts: pick(lower, TS_KEYS),
    level: pick(lower, LEVEL_KEYS),
    message: pick(lower, MSG_KEYS),
  };
}

// ── Non-JSON format parsers ──────────────────────────────────────────────────
// Each returns a field map (canonical lower-case keys where known) or null.

/**
 * logfmt — `key=value key2="quoted value"`. Requires the whole line to be
 * key=value pairs (≥2) so free-text lines (e.g. syslog) aren't misread as logfmt.
 */
export function parseLogfmt(line: string): Record<string, unknown> | null {
  const re = /([\w.\-/]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
  const obj: Record<string, unknown> = {};
  let count = 0;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (line.slice(cursor, m.index).trim() !== "") return null; // non-kv text between pairs
    let val: string = m[2];
    if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      try {
        val = JSON.parse(val);
      } catch {
        val = val.slice(1, -1);
      }
    }
    obj[m[1]] = val;
    count++;
    cursor = m.index + m[0].length;
  }
  if (count < 2 || line.slice(cursor).trim() !== "") return null;
  return obj;
}

const SYSLOG_BSD =
  /^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\s:[]+)(?:\[(\d+)\])?:\s?(.*)$/;
const SYSLOG_ISO =
  /^(\d{4}-\d{2}-\d{2}T[\d:.,+\-Z]+)\s+(\S+)\s+([^\s:[]+)(?:\[(\d+)\])?:\s?(.*)$/;

/** syslog RFC 3164 (BSD) or rsyslog ISO-timestamp variant. */
export function parseSyslog(line: string): Record<string, unknown> | null {
  const m = SYSLOG_BSD.exec(line) ?? SYSLOG_ISO.exec(line);
  if (!m) return null;
  const obj: Record<string, unknown> = {
    timestamp: m[1],
    host: m[2],
    process: m[3],
    message: m[5],
  };
  if (m[4]) obj.pid = m[4];
  return obj;
}

const NGINX =
  /^(\S+) \S+ (\S+) \[([^\]]+)\] "([A-Z]+) (\S+) ([^"]*)" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?/;

/** nginx/apache common & combined access log formats. */
export function parseNginx(line: string): Record<string, unknown> | null {
  const m = NGINX.exec(line);
  if (!m) return null;
  const status = m[7];
  const obj: Record<string, unknown> = {
    ip: m[1],
    timestamp: m[3],
    method: m[4],
    path: m[5],
    protocol: m[6],
    status,
    bytes: m[8],
    message: `${m[4]} ${m[5]} → ${status}`,
  };
  if (m[2] !== "-") obj.user = m[2];
  if (m[9]) obj.referer = m[9];
  if (m[10]) obj.useragent = m[10];
  const code = parseInt(status, 10);
  if (code >= 500) obj.level = "error";
  else if (code >= 400) obj.level = "warn";
  return obj;
}

const DMESG_UPTIME = /^\[\s*(\d+\.\d+)\]\s(.*)$/;
const DMESG_HUMAN = /^\[(\w{3} \w{3} +\d+ \d{2}:\d{2}:\d{2} \d{4})\]\s(.*)$/;

/** Kernel ring buffer (`dmesg`): `[ 1234.567] msg` or `dmesg -T` human time. */
export function parseDmesg(line: string): Record<string, unknown> | null {
  const m = DMESG_UPTIME.exec(line) ?? DMESG_HUMAN.exec(line);
  if (!m) return null;
  return { timestamp: m[1], message: m[2] };
}

// Detection order: JSON and nginx are unambiguous; syslog/dmesg are specific;
// logfmt is the most permissive so it goes last (and is itself guarded).
const PARSERS: [LogFormat, (line: string) => Record<string, unknown> | null][] = [
  ["json", parseLogLine],
  ["nginx", parseNginx],
  ["syslog", parseSyslog],
  ["dmesg", parseDmesg],
  ["logfmt", parseLogfmt],
];

/**
 * Parse one output line into a structured entry by auto-detecting its format,
 * or null when no format matches (plain text is left out of the table).
 */
export function toLogEntry(line: string, seq: number): JsonLogEntry | null {
  const source = stripAnsi(line).trim();
  if (!source) return null;
  for (const [format, parse] of PARSERS) {
    const obj = parse(source);
    if (obj) return { seq, ...extractFields(obj), raw: obj, format, source };
  }
  return null;
}

/** Broad severity category a raw level string maps to (drives colours + chips). */
export type LevelCat = "error" | "warn" | "info" | "debug" | "other";

/** All categories, in display order (for the level filter chips). */
export const LEVEL_CATS: LevelCat[] = ["error", "warn", "info", "debug", "other"];

/** Classify a raw level string into a broad category. */
export function levelCategory(level: string | null): LevelCat {
  if (!level) return "other";
  const l = level.toLowerCase().trim();
  // Numeric syslog severity (journald PRIORITY): 0-3 error, 4 warn, 5-6 info, 7 debug.
  if (/^\d+$/.test(l)) {
    const n = parseInt(l, 10);
    if (n <= 3) return "error";
    if (n === 4) return "warn";
    if (n <= 6) return "info";
    return "debug";
  }
  if (/(emerg|alert|crit|fatal|error|err)/.test(l)) return "error";
  if (/warn/.test(l)) return "warn";
  if (/(debug|trace|verbose)/.test(l)) return "debug";
  if (/(info|notice)/.test(l)) return "info";
  return "other";
}

/** Tailwind class colouring a log level (ok → '', warn → amber, error → red). */
export function levelClass(level: string | null): string {
  switch (levelCategory(level)) {
    case "error":
      return "text-danger";
    case "warn":
      return "text-warn";
    case "debug":
      return "text-muted";
    default:
      return "";
  }
}

/** Union of all raw keys across entries, sorted — candidates for extra columns. */
export function availableFields(entries: JsonLogEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) for (const k of Object.keys(e.raw)) set.add(k);
  return [...set].sort();
}

/** Stringify a raw field for a table cell (objects → compact JSON, null → ""). */
export function fieldValue(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Best-effort normalisation of a timestamp to local `YYYY-MM-DD HH:MM:SS`.
 * Handles epoch seconds/ms/µs (journald), ISO 8601, and syslog `Mon DD HH:MM:SS`
 * (assumes the current year). Kernel uptime (`1234.567`) and anything unparseable
 * are returned unchanged so nothing is lost.
 */
export function normalizeTime(ts: string | null): string {
  if (!ts) return "";
  const s = ts.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    let ms: number;
    if (s.length >= 16) ms = Math.floor(n / 1000); // microseconds
    else if (s.length >= 13) ms = n; // milliseconds
    else if (s.length >= 10) ms = n * 1000; // seconds
    else return s; // too short to be an epoch
    return formatDate(new Date(ms));
  }
  if (/^\d+\.\d+$/.test(s)) return s; // kernel uptime — not a wall-clock time
  let d = new Date(s);
  // syslog "Mon DD HH:MM:SS" has no year — append the current one. Guarded by a
  // strict pattern so arbitrary text isn't coerced into a bogus date.
  if (isNaN(d.getTime()) && /^[A-Za-z]{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}$/.test(s)) {
    d = new Date(`${s} ${new Date().getFullYear()}`);
  }
  return isNaN(d.getTime()) ? s : formatDate(d);
}

function formatDate(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * Case-insensitive substring filter over an entry's timestamp, level, message
 * and full raw JSON. Empty query returns everything.
 */
export function filterEntries(entries: JsonLogEntry[], query: string): JsonLogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const hay = `${e.ts ?? ""} ${e.level ?? ""} ${e.message ?? ""} ${JSON.stringify(e.raw)}`;
    return hay.toLowerCase().includes(q);
  });
}

/**
 * Combined text + level-category filter. `levels` is the set of enabled
 * categories; when it's empty or covers every category, no level filtering is
 * applied (so the default "all chips on" — and "all chips off" — shows everything).
 */
export function applyFilters(
  entries: JsonLogEntry[],
  query: string,
  levels: LevelCat[],
): JsonLogEntry[] {
  const byText = filterEntries(entries, query);
  const set = new Set(levels);
  if (set.size === 0 || LEVEL_CATS.every((c) => set.has(c))) return byText;
  return byText.filter((e) => set.has(levelCategory(e.level)));
}
