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
