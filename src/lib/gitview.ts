// Small pure view helpers for the Git panel (Phase 29) — kept out of components
// so they unit-test without DOM. Colors map to the same Tailwind utilities used
// across the app; labels are resolved via i18n at the call site (these return
// canonical keys/letters only where noted).

/** Tailwind text-color class for a git status letter (name-status or porcelain). */
export function fileStatusColor(status: string): string {
  switch (status[0]) {
    case "A":
    case "?":
      return "text-green-400";
    case "M":
      return "text-amber-400";
    case "D":
      return "text-red-400";
    case "R":
    case "C":
      return "text-blue-400";
    case "U":
      return "text-red-300";
    default:
      return "text-muted";
  }
}

/**
 * Compose the hover tooltip for a commit: full subject, then the body (if any),
 * then a metadata line (author · relative time · short hash). `now` is injectable
 * for deterministic tests. Pure — the `.vt-tooltip` bubble renders `\n` as line
 * breaks (`white-space: pre-line`).
 */
export function commitTooltip(
  c: { subject: string; body: string; author: string; short: string; timestamp: number },
  now: number = Date.now(),
): string {
  const parts = [c.subject.trim()];
  const body = c.body.trim();
  if (body) parts.push(body);
  parts.push(`— ${c.author} · ${relTime(c.timestamp, now)} · ${c.short}`);
  return parts.join("\n\n");
}

/**
 * Compact relative time from a unix timestamp (seconds). `now` is injectable so
 * the formatting is deterministic in tests. Returns e.g. `now`, `5m`, `3h`,
 * `2d`, `4w`, `1y`.
 */
export function relTime(tsSec: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor(now / 1000) - tsSec);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(days / 365)}y`;
}
