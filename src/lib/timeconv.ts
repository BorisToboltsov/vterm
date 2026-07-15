// Pure Unix-time ↔ date conversion (Phase 33). DOM-free: relies only on Date and
// Intl, both available in the browser and vitest. The component renders these; it
// keeps no time logic of its own. Offline.

export type EpochUnit = "auto" | "s" | "ms";

/** Guess whether a raw epoch number is seconds or milliseconds by magnitude. */
export function detectUnit(n: number): "s" | "ms" {
  // ~2001-09-09 in seconds is 1e9; the same instant in ms is 1e12, so anything
  // at or above 1e12 is almost certainly milliseconds.
  return Math.abs(n) >= 1e12 ? "ms" : "s";
}

/** Build a Date from an epoch value in the given (or auto-detected) unit. */
export function epochToDate(value: number, unit: EpochUnit): Date {
  const u = unit === "auto" ? detectUnit(value) : unit;
  return new Date(u === "s" ? value * 1000 : value);
}

/** Parse a pure integer epoch string. Returns null when not an integer / invalid. */
export function parseEpoch(text: string, unit: EpochUnit): Date | null {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const d = epochToDate(n, unit);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse a date string (ISO 8601 and other Date-recognised formats). */
export function parseDateString(text: string): Date | null {
  const t = text.trim();
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Parse either an integer epoch or a date string, auto-detecting which. Used by
 * the single-field UI so the user can paste whatever they have.
 */
export function parseFlexible(text: string, unit: EpochUnit): Date | null {
  const t = text.trim();
  if (/^-?\d+$/.test(t)) return parseEpoch(t, unit);
  return parseDateString(t);
}

export function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function toEpochMillis(date: Date): number {
  return date.getTime();
}

/** Is `tz` a valid IANA time-zone name? */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Format an instant in a specific time zone as `YYYY-MM-DD HH:mm:ss ZZZ` (24h).
 * Throws RangeError on an unknown zone — callers should guard with isValidTimeZone.
 */
export function formatInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const zone = get("timeZoneName");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${zone}`;
}

export interface RelativePart {
  value: number;
  unit: Intl.RelativeTimeFormatUnit;
}

/**
 * The largest sensible relative-time unit between `date` and `now` (signed:
 * negative = in the past). The component turns this into localized text via
 * Intl.RelativeTimeFormat.
 */
export function relativeParts(date: Date, now: Date = new Date()): RelativePart {
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const sec = 1000;
  const min = 60 * sec;
  const hr = 60 * min;
  const day = 24 * hr;
  const wk = 7 * day;
  const mo = 30 * day;
  const yr = 365 * day;
  const pick = (div: number, unit: Intl.RelativeTimeFormatUnit): RelativePart => ({
    value: Math.round(diff / div),
    unit,
  });
  if (abs < min) return pick(sec, "second");
  if (abs < hr) return pick(min, "minute");
  if (abs < day) return pick(hr, "hour");
  if (abs < wk) return pick(day, "day");
  if (abs < mo) return pick(wk, "week");
  if (abs < yr) return pick(mo, "month");
  return pick(yr, "year");
}
