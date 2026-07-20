// Transfer-rate and ETA maths for SFTP progress (Phase 42). Pure so the sliding
// window can be tested with a fake clock instead of a real upload.
//
// The backend already emits `sftp://progress` with `transferred`/`total`; nothing
// new is asked of it. Rate is derived on the front from the deltas between
// consecutive snapshots, which is also why it is a *window* and not
// `transferred / elapsed`: an average over the whole transfer keeps quoting the
// speed of the first ten seconds long after the link has degraded, and the ETA
// built on it is confidently wrong.

/** One observation of a transfer's progress counter. */
export interface RateSample {
  /** Timestamp in ms (monotonic source preferred — `performance.now()`). */
  at: number;
  /** Bytes for single files; completed-file count for folders. */
  transferred: number;
}

/** How much history the rate averages over. */
export const RATE_WINDOW_MS = 5000;
/** Minimum span before a rate is reported — below this the number is noise. */
export const MIN_SPAN_MS = 500;

/**
 * Append an observation, dropping samples that fell out of the window.
 *
 * The pre-cutoff sample is kept only when the window alone cannot produce two
 * points — a transfer that reports once every 30s would otherwise never have a
 * rate at all. Keeping it unconditionally is the tempting version and it is
 * wrong: with frequent updates the window then always reaches back to the first
 * sample, and the "sliding" average silently becomes the whole-transfer average
 * this module exists to avoid.
 */
export function pushSample(
  samples: readonly RateSample[],
  at: number,
  transferred: number,
): RateSample[] {
  const next = [...samples, { at, transferred }];
  const cutoff = at - RATE_WINDOW_MS;
  const inside = next.filter((s) => s.at >= cutoff);
  return inside.length >= 2 ? inside : next.slice(-2);
}

/**
 * Units per second across the window, or null when it cannot be known yet
 * (too few samples, too short a span, or a counter that went backwards —
 * which happens when a folder transfer moves on to a new file).
 */
export function sampleRate(samples: readonly RateSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS) return null;
  const delta = last.transferred - first.transferred;
  if (delta < 0) return null;
  return (delta / span) * 1000;
}

/**
 * Seconds until completion, or null when unknowable. A rate of zero means
 * stalled, not "arriving now" — reporting 0 s there would be a lie the progress
 * bar then sits on for minutes.
 */
export function etaSeconds(
  transferred: number,
  total: number,
  rate: number | null,
): number | null {
  if (rate == null || rate <= 0) return null;
  if (!(total > 0)) return null;
  const remaining = total - transferred;
  if (remaining <= 0) return 0;
  return remaining / rate;
}

/**
 * Clock-form remaining time: "0:42", "3:20", "1:05:00". Language-neutral on
 * purpose (same shape as the recording player's `formatTime`) — the caller adds
 * the translated "left" label. Null renders as an em dash, not a fake zero.
 */
export function fmtEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Completion percent, clamped to 0…100. */
export function transferPct(transferred: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((transferred / total) * 100)));
}
