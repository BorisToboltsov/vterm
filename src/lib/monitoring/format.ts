// Pure formatting helpers for the bottom status bar. Extracted from
// StatusBar.svelte so they can be unit-tested without a component/DOM.

import type { Metrics } from "../api";
import type { IconName } from "../ui/icons";

/** Human-readable byte size: GiB with one decimal ≥1 GiB, else whole MiB. */
export function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  const gib = n / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  const mib = n / 1024 ** 2;
  return `${mib.toFixed(0)} MiB`;
}

/** Registry icon name for the remote OS, matched against `os` + `prettyName`. */
export function osIcon(os: string, prettyName: string): IconName {
  const s = `${os} ${prettyName}`.toLowerCase();
  if (s.includes("darwin") || s.includes("mac")) return "osApple";
  if (s.includes("bsd")) return "osBsd";
  if (s.includes("windows")) return "osWindows";
  if (s.includes("linux") || os) return "osLinux";
  return "osUnknown";
}

/** Network rate (bytes/sec) as a short human string: "1.2 MB/s", or "—" for null. */
export function fmtRate(n: number | null): string {
  const p = rateParts(n);
  return p ? `${p.num} ${p.unit}` : "—";
}

/**
 * A rate as its number and its unit, apart — the status bar draws the unit
 * dimmer, in a fixed slot. A value that rounds up to 1024 of a unit is told in
 * the next one: 1023.7 KB/s is "1.0 MB/s", never "1024 KB/s".
 */
export function rateParts(n: number | null): { num: string; unit: string; value: number } | null {
  if (n == null || !Number.isFinite(n)) return null;
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = Math.max(0, n);
  let i = 0;
  const shown = (x: number, at: number) => (at === 0 ? Math.round(x) : Number(x.toFixed(x < 10 ? 1 : 0)));
  while (i < units.length - 1 && shown(v, i) >= 1024) {
    v /= 1024;
    i++;
  }
  const num = i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0);
  return { num, unit: units[i], value: v };
}

/** Uptime seconds → "5d 3h" / "3h 12m" / "12m"; "—" for null. */
export function fmtUptime(secs: number | null): string {
  if (secs == null) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Memory used as a whole-number percentage, or null when data is missing. */
export function memPct(used: number | null, total: number | null): number | null {
  return used != null && total ? Math.round((used / total) * 100) : null;
}

/** A percentage value as "42%", or "—" when null. */
export function fmtPct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)}%`;
}

/** Free disk bytes (total − used), or null when either value is missing. */
export function diskFree(used: number | null, total: number | null): number | null {
  return total != null && used != null ? total - used : null;
}

// A ceiling reported around i64::MAX means "no limit" — e.g. an unlimited
// `fs.file-max`, which would otherwise render as 9,223,372,036,854,776,000.
const UNLIMITED_MIN = 1e15;

/** True when a numeric ceiling is effectively unlimited (~i64::MAX sentinel). */
export function isUnlimitedLimit(n: number | null): boolean {
  return n != null && n >= UNLIMITED_MIN;
}

/** Format a ceiling: "∞" when effectively unlimited, localized count, else "—". */
export function fmtLimit(n: number | null): string {
  if (n == null) return "—";
  return isUnlimitedLimit(n) ? "∞" : n.toLocaleString();
}

/** Convenience wrapper: pick the OS icon straight from a Metrics object. */
export const osIconFor = (m: Pick<Metrics, "os" | "prettyName">): IconName =>
  osIcon(m.os, m.prettyName);

/** Request latency in ms: "0.4 ms", "12 ms"; "—" for null. */
export function fmtMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

/** Seconds before now as a time mark under a chart: "−3:20", "−10:00", or "" at now. */
export function fmtAgo(secs: number): string {
  const total = Math.round(secs);
  if (!(total > 0)) return "";
  return `−${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A clock frequency: "2.40 GHz" from 1 GHz, else "800 MHz"; "—" for null. */
export function fmtMhz(mhz: number | null | undefined): string {
  if (mhz == null || !Number.isFinite(mhz)) return "—";
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`;
}

/** A count with the locale's grouping, "—" for null. */
export function fmtCount(n: number | null | undefined): string {
  return n == null ? "—" : Math.round(n).toLocaleString();
}
