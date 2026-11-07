// The text of a container's or a pod's log as the details show it (v1.33): the
// pure half of `LogTail.svelte` (ADR 0003). The log itself is a snapshot the
// panel re-asks for (`docker logs --tail N --timestamps`, `kubectl logs …`) —
// never a stream, INVARIANTS «Живой вид — снимок»; here is only how the lines of
// it are read: the timestamp docker and kubectl put in front, the severity the
// line names, which lines a filter keeps.
//
// The severity is read from the text of the line — the word `ERROR`, `warn`,
// klog's `E1106` — and so it is a hint, not a parse: a line that does not say
// its level has none, and the filter that keeps only errors drops it.

/** How many lines the details ask for. */
export const LOG_TAILS = [200, 1000, 5000] as const;
export type LogTailSize = (typeof LOG_TAILS)[number];

/** Which lines a level filter keeps: all, warnings and errors, errors. */
export type LogLevelFilter = "all" | "warn" | "error";

export type LineLevel = "error" | "warn" | null;

/** One line of a log as the view draws it. */
export interface LogLine {
  /** Index in the fetched text — a stable key while the snapshot is the same. */
  n: number;
  /** The timestamp docker or kubectl wrote in front; null — none. */
  ts: string | null;
  /** The line after it. */
  text: string;
  level: LineLevel;
}

/** `2026-11-06T10:41:02.123456789Z ` — RFC 3339 with an optional fraction and offset. */
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s/;

const ERROR = /\b(?:fatal|panic|crit(?:ical)?|emerg(?:ency)?|err(?:or)?|exception)\b|^[EF]\d{4} /i;
const WARN = /\b(?:warn(?:ing)?)\b|^W\d{4} /i;

/** The severity a line names, if it names one. */
export function lineLevel(text: string): LineLevel {
  if (ERROR.test(text)) return "error";
  if (WARN.test(text)) return "warn";
  return null;
}

/** The lines of a fetched log; the empty last line a trailing newline leaves is not one. */
export function logLines(raw: string): LogLine[] {
  const parts = raw.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.map((line, n) => {
    const clean = line.replace(/\r$/, "");
    const m = STAMP.exec(clean);
    const text = m ? clean.slice(m[0].length) : clean;
    return { n, ts: m ? m[1] : null, text, level: lineLevel(text) };
  });
}

/** Whether a line passes a level filter. */
export function keepsLevel(level: LineLevel, filter: LogLevelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "error") return level === "error";
  return level === "error" || level === "warn";
}

/** The lines a filter keeps: the level, and the text anywhere in the line, case ignored. */
export function filterLines(lines: readonly LogLine[], text: string, level: LogLevelFilter): LogLine[] {
  const needle = text.trim().toLowerCase();
  return lines.filter(
    (l) => keepsLevel(l.level, level) && (!needle || `${l.ts ?? ""} ${l.text}`.toLowerCase().includes(needle)),
  );
}

/**
 * A timestamp as the view prints it: the time of day in the viewer's zone, with
 * seconds — the date is in the tooltip (the whole stamp). Unreadable — as written.
 */
export function shortStamp(ts: string, timeZone?: string): string {
  const t = Date.parse(ts.replace(/(\.\d{3})\d+/, "$1"));
  if (!Number.isFinite(t)) return ts;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).format(t);
}

/** The lines as text again — what «Copy» puts on the clipboard: what is shown, as shown. */
export function linesText(lines: readonly LogLine[], withStamps: boolean): string {
  return lines.map((l) => (withStamps && l.ts ? `${l.ts} ${l.text}` : l.text)).join("\n");
}

/** A tail size from anything stored or picked; unknown — the smallest. */
export function sanitizeTail(v: unknown): LogTailSize {
  return (LOG_TAILS as readonly number[]).includes(v as number) ? (v as LogTailSize) : LOG_TAILS[0];
}
