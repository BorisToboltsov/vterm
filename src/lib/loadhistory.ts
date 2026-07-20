// Rolling load history for the Docker and k8s panels (Phase 42). Pure so the
// retention and drop rules are testable without a poller.
//
// Both panels already take a fresh snapshot every few seconds (`docker stats
// --no-stream`, `kubectl top pods`) and throw the previous one away, so a row can
// only ever show an instant. Keeping the last N snapshots per object costs
// nothing at the backend — no new command, no new poll — and turns the row into a
// shape: "this container has been pinned at 90% for a minute" versus "it just
// spiked". That is the question you actually open the panel to answer.
//
// `parsePercent` lives here because both panels receive their numbers as display
// strings and never needed them numeric before. The kubectl quantity parsers live
// in k8s.ts — they are that CLI's vocabulary, not this module's.

/** How many snapshots a sparkline keeps. At a 3–5s poll this is ~1–2 minutes. */
export const HISTORY_LEN = 24;

/** Per-object sample history, oldest → newest, keyed by object id. */
export type LoadHistory = Record<string, number[]>;

/**
 * Fold a new snapshot into the history.
 *
 * - objects missing from `live` are dropped entirely (a removed container must
 *   not keep its history alive, nor leak once the panel runs for hours);
 * - objects in `live` with no reading this cycle keep the history they had.
 *   Pushing a zero would draw a dip that never happened — the same "don't render
 *   a plausible placeholder instead of an honest gap" rule the metrics UI follows.
 */
export function pushSamples(
  prev: LoadHistory,
  live: readonly string[],
  values: ReadonlyMap<string, number>,
): LoadHistory {
  const next: LoadHistory = {};
  for (const id of live) {
    const history = prev[id] ?? [];
    const v = values.get(id);
    next[id] = v == null ? history : [...history, v].slice(-HISTORY_LEN);
  }
  return next;
}

/**
 * Full-scale value for a sparkline: the series peak, never below `floor`. A
 * per-row auto-scale would make an idle container's noise look like a busy one's
 * load, so callers pass a floor that means "normal full scale" (100 for a
 * percentage) and only go above it when the data genuinely does.
 */
export function historyMax(values: readonly number[], floor: number): number {
  return Math.max(floor, ...values, 0);
}

/** Left-pads a series to `HISTORY_LEN` so a young sparkline fills from the right. */
export function padHistory(values: readonly number[], len: number = HISTORY_LEN): number[] {
  if (values.length >= len) return values.slice(-len);
  return [...new Array<number>(len - values.length).fill(0), ...values];
}

/** `"12.34%"` → 12.34. Null for the CLI's placeholders (`"--"`, `""`). */
export function parsePercent(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
