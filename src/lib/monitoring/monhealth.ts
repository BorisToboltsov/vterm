// Level primitives for monitoring (Phase 13, v1.33). The monitoring page files
// every problem in monproblems.ts and takes a section's level as the worst of its
// problems; the primitives that list and the screensaver share live here, pure
// and unit-tested:
//   • `worstLevel` — several levels reduced to the most severe;
//   • `loadCoreLevel` — load relative to the number of logical CPUs;
//   • `sensorLevel` — a sensor by its own crit/high, else the cpuTemp threshold;
//   • `loadHealth` — load1 against its threshold and per core, worst of the two.
// The numeric thresholds come from the user's settings
// (`settings.statusBarThresholds`) via `thresholdLevel`; a `null` bound there
// means that breach is disabled.

import { thresholdLevel, type ThresholdLevel } from "./thresholds";
import type { Threshold } from "../settings/settings.svelte";
import type { Sensor } from "../api";

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

export function loadHealth(
  load1: number | null,
  loadPerCore: number | null,
  loadTh: Threshold | undefined,
): ThresholdLevel {
  return worstLevel([thresholdLevel(load1, loadTh), loadCoreLevel(loadPerCore)]);
}

