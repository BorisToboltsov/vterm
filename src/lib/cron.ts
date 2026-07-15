// Pure 5-field cron parsing + next-run computation (Phase 33). DOM-free and
// offline. Supports `*`, lists (`1,2`), ranges (`1-5`), steps (`*/5`, `0-30/10`),
// 3-letter month/weekday names, `0`/`7` = Sunday, and the common `@macros`.
// Human-readable explanation is intentionally left to the component (it renders a
// per-field breakdown + names via Intl) so no natural-language text lives here.

export type CronError = "empty" | "fieldCount" | "invalidField";

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>; // 0-6, Sunday = 0
  /** Whether the day-of-month field was `*` (drives DOM/DOW union semantics). */
  domStar: boolean;
  /** Whether the day-of-week field was `*`. */
  dowStar: boolean;
}

export type CronParse =
  | { ok: true; fields: CronFields; normalized: string }
  | { ok: false; error: CronError };

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Replace 3-letter names with their numeric value (offset = value of the first name). */
function replaceNames(token: string, names: string[], offset: number): string {
  let out = token.toLowerCase();
  names.forEach((n, i) => {
    out = out.replace(new RegExp(n, "g"), String(i + offset));
  });
  return out;
}

/** Parse one cron field into the set of matched values, or throw on any malformation. */
function parseField(rawToken: string, min: number, max: number): Set<number> {
  const set = new Set<number>();
  for (const part of rawToken.split(",")) {
    if (part === "") throw new Error("empty part");
    const slash = part.split("/");
    if (slash.length > 2) throw new Error("bad step");
    let step = 1;
    if (slash.length === 2) {
      step = Number(slash[1]);
      if (!Number.isInteger(step) || step <= 0) throw new Error("bad step");
    }
    const range = slash[0];
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error("out of range");
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

/** Parse a 5-field cron expression (or a `@macro`). */
export function parseCron(expr: string): CronParse {
  const trimmed = expr.trim();
  if (!trimmed) return { ok: false, error: "empty" };

  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: "fieldCount" };

  const [m, h, dom, mon, dow] = parts;
  try {
    const minute = parseField(m, 0, 59);
    const hour = parseField(h, 0, 23);
    const domSet = parseField(dom, 1, 31);
    const month = parseField(replaceNames(mon, MONTH_NAMES, 1), 1, 12);
    const dowRaw = parseField(replaceNames(dow, DOW_NAMES, 0), 0, 7);
    const dowSet = new Set([...dowRaw].map((v) => (v === 7 ? 0 : v)));
    return {
      ok: true,
      fields: {
        minute,
        hour,
        dom: domSet,
        month,
        dow: dowSet,
        domStar: dom === "*",
        dowStar: dow === "*",
      },
      normalized: parts.join(" "),
    };
  } catch {
    return { ok: false, error: "invalidField" };
  }
}

/** Whether a cron schedule fires at the given (local-time) date/minute. */
export function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false;
  if (!fields.hour.has(date.getHours())) return false;
  if (!fields.month.has(date.getMonth() + 1)) return false;

  const domMatch = fields.dom.has(date.getDate());
  const dowMatch = fields.dow.has(date.getDay());
  // Vixie cron: when both day fields are restricted, either match fires.
  if (!fields.domStar && !fields.dowStar) return domMatch || dowMatch;
  if (!fields.domStar) return domMatch;
  if (!fields.dowStar) return dowMatch;
  return true;
}

/**
 * The next `count` fire times strictly after `from`, scanning minute by minute.
 * Bounded to ~2 years so a schedule that never fires again returns what it found
 * rather than looping forever.
 */
export function nextRuns(fields: CronFields, from: Date, count: number): Date[] {
  const out: Date[] = [];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const maxIter = 366 * 24 * 60 * 2;
  for (let i = 0; i < maxIter && out.length < count; i++) {
    if (cronMatches(fields, d)) out.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}
