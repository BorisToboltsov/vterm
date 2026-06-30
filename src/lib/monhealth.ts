// Per-block health for the monitoring page (Phase 13). Each detail block reduces
// to one level — ok | warn | crit — used for the section-header indicator and the
// at-a-glance health summary in the System block. Pure logic, unit-tested.
//
// HOW EACH BLOCK'S LEVEL IS DERIVED (single source of truth):
//   • The numeric thresholds come from the user's settings
//     (`settings.statusBarThresholds`, the same `warn`/`crit` used to colour
//     numbers in the bar and page) via `thresholdLevel`. A `null` bound there
//     means that breach is disabled.
//   • Each block takes the WORST of its relevant metrics (`worstLevel`):
//     - CPU      → cpu% vs `cpu`
//     - Memory   → RAM% vs `ram`, swap% vs `swap`
//     - Disk     → per-partition used% vs `disk`, inodes% vs `inodes`, FD% vs `fd`
//     - Load     → load1 vs `load` AND load-per-core (≥1 crit, ≥0.7 warn)
//     - Network  → warn if any interface has errors/drops > 0 (no user threshold)
//     - Temp     → per-sensor crit/high, else cpuTemp vs `cpuTemp`
//     - Extras   → SMART not "PASSED" → crit; OOM kills > 0 → warn

import { thresholdLevel, type ThresholdLevel } from "./thresholds";
import type { Threshold, StatusBarThresholds } from "./settings.svelte";
import type { Metrics, MetricsDetail, Extras, Sensor } from "./api";
import { memPct, isUnlimitedLimit } from "./format";

const RANK: Record<ThresholdLevel, number> = { ok: 0, warn: 1, crit: 2 };

/** Reduce several levels to the most severe ("crit" > "warn" > "ok"). */
export function worstLevel(levels: ThresholdLevel[]): ThresholdLevel {
  return levels.reduce<ThresholdLevel>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");
}

/** Load relative to core count: ≥1 → crit, ≥0.7 → warn, else ok; null → ok. */
export function loadCoreLevel(loadPerCore: number | null): ThresholdLevel {
  if (loadPerCore == null) return "ok";
  if (loadPerCore >= 1) return "crit";
  if (loadPerCore >= 0.7) return "warn";
  return "ok";
}

/** One sensor: its own crit/high limits first, else fall back to cpuTemp thresholds. */
export function sensorLevel(s: Sensor, cpuTempTh: Threshold | undefined): ThresholdLevel {
  if (s.crit != null && s.temp >= s.crit) return "crit";
  if (s.high != null && s.temp >= s.high) return "warn";
  return thresholdLevel(s.temp, cpuTempTh);
}

function pct(used: number, total: number): number | null {
  return total > 0 ? (used / total) * 100 : null;
}

export function cpuHealth(m: Metrics | null, th: StatusBarThresholds): ThresholdLevel {
  return thresholdLevel(m?.cpuPct ?? null, th.cpu);
}

export function memHealth(m: Metrics | null, th: StatusBarThresholds): ThresholdLevel {
  return worstLevel([
    thresholdLevel(memPct(m?.memUsed ?? null, m?.memTotal ?? null), th.ram),
    thresholdLevel(memPct(m?.swapUsed ?? null, m?.swapTotal ?? null), th.swap),
  ]);
}

export function fsHealth(d: MetricsDetail | null, th: StatusBarThresholds): ThresholdLevel {
  const levels: ThresholdLevel[] = [];
  for (const p of d?.partitions ?? []) {
    levels.push(thresholdLevel(pct(p.used, p.total), th.disk));
    if (p.inodesUsed != null && p.inodesTotal) {
      levels.push(thresholdLevel(pct(p.inodesUsed, p.inodesTotal), th.inodes));
    }
  }
  if (d?.fileNrUsed != null && d.fileNrMax && !isUnlimitedLimit(d.fileNrMax)) {
    levels.push(thresholdLevel((d.fileNrUsed / d.fileNrMax) * 100, th.fd));
  }
  return worstLevel(levels);
}

export function loadHealth(
  load1: number | null,
  loadPerCore: number | null,
  loadTh: Threshold | undefined,
): ThresholdLevel {
  return worstLevel([thresholdLevel(load1, loadTh), loadCoreLevel(loadPerCore)]);
}

/** Network is "warn" when any interface reports errors or drops, else "ok". */
export function netHealth(d: MetricsDetail | null): ThresholdLevel {
  const bad = (d?.netIfaces ?? []).some(
    (n) => n.rxErrs + n.rxDrop + n.txErrs + n.txDrop > 0,
  );
  return bad ? "warn" : "ok";
}

/** True when temperature data exists (sensors or a CPU temp reading). */
export function hasTempData(d: MetricsDetail | null, m: Metrics | null): boolean {
  return (d?.sensors?.length ?? 0) > 0 || (m?.cpuTemp ?? null) != null;
}

export function tempHealth(
  d: MetricsDetail | null,
  m: Metrics | null,
  th: StatusBarThresholds,
): ThresholdLevel {
  const sensors = d?.sensors ?? [];
  if (sensors.length > 0) {
    return worstLevel(sensors.map((s) => sensorLevel(s, th.cpuTemp)));
  }
  return thresholdLevel(m?.cpuTemp ?? null, th.cpuTemp);
}

export function extrasHealth(e: Extras | null): ThresholdLevel {
  if (!e) return "ok";
  const smartBad = e.smart.some((d) => d.health && d.health !== "PASSED");
  if (smartBad) return "crit";
  if ((e.oomKills ?? 0) > 0) return "warn";
  return "ok";
}
