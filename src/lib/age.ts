// Compact age for list rows (Docker images, k8s objects). One formatter for
// every panel, so "3w" means the same thing wherever it appears. Pure: the
// caller supplies both instants. Language-independent on purpose — the units are
// the kubectl ones admins already read, so there is nothing to translate.

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

/**
 * Compact age between two instants: "45s", "12m", "3h20m", "5d4h", "9d", "3w",
 * "8mo", "2y". Two units at most, and only while the second one still matters
 * (under a week); past that a single coarser unit, so the column stays ≤ 5
 * characters whatever the age. A future `thenMs` (clock skew) clamps to "0s".
 */
export function compactAge(thenMs: number, nowMs: number): string {
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return "";
  let s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  const d = Math.floor(s / DAY);
  s -= d * DAY;
  const h = Math.floor(s / HOUR);
  s -= h * HOUR;
  const m = Math.floor(s / MIN);
  s -= m * MIN;
  if (d >= 730) return `${Math.floor(d / 365)}y`;
  if (d >= 60) return `${Math.floor(d / 30)}mo`;
  if (d >= 14) return `${Math.floor(d / 7)}w`;
  if (d > 0) return h > 0 && d < 7 ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
