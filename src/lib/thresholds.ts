// Pure threshold logic for monitoring metrics. Extracted so it can be unit-tested
// without a component/DOM and reused by both the status bar and the monitoring
// overlay. A numeric value is compared against an average (warn → amber) and a
// limit (crit → red); the higher breach wins.

import type { Threshold } from "./settings.svelte";

export type ThresholdLevel = "ok" | "warn" | "crit";

/**
 * Classify `value` against a metric's thresholds. A `null` value or absent/empty
 * threshold yields "ok". `crit` takes precedence over `warn`; either bound may be
 * `null` (disabled). Comparison is inclusive (value ≥ bound triggers it).
 */
export function thresholdLevel(
  value: number | null | undefined,
  t: Threshold | undefined,
): ThresholdLevel {
  if (value == null || !t) return "ok";
  if (t.crit != null && value >= t.crit) return "crit";
  if (t.warn != null && value >= t.warn) return "warn";
  return "ok";
}

/** Tailwind text-colour class for a level ("" for ok — inherit surrounding colour). */
export function levelTextClass(level: ThresholdLevel): string {
  if (level === "crit") return "text-danger";
  if (level === "warn") return "text-warn";
  return "";
}

/** Convenience: classify and return the text-colour class in one call. */
export function thresholdClass(
  value: number | null | undefined,
  t: Threshold | undefined,
): string {
  return levelTextClass(thresholdLevel(value, t));
}
