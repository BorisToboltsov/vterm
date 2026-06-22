// Pure formatting helpers for the bottom status bar. Extracted from
// StatusBar.svelte so they can be unit-tested without a component/DOM.

import type { Metrics } from "./api";
import type { IconName } from "./icons";

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
  if (n == null) return "—";
  if (n < 1024) return `${Math.round(n)} B/s`;
  const units = ["KB/s", "MB/s", "GB/s"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
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

/** Free disk bytes (total − used), or null when either value is missing. */
export function diskFree(used: number | null, total: number | null): number | null {
  return total != null && used != null ? total - used : null;
}

/** Convenience wrapper: pick the OS icon straight from a Metrics object. */
export const osIconFor = (m: Pick<Metrics, "os" | "prettyName">): IconName =>
  osIcon(m.os, m.prettyName);
