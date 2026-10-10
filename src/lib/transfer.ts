// Transfer-rate and ETA maths for SFTP progress (Phase 42). Pure so the sliding
// window can be tested with a fake clock instead of a real upload.
//
// The backend already emits `sftp://progress` with `transferred`/`total`; nothing
// new is asked of it. Rate is derived on the front from the deltas between
// consecutive snapshots, which is also why it is a *window* and not
// `transferred / elapsed`: an average over the whole transfer keeps quoting the
// speed of the first ten seconds long after the link has degraded, and the ETA
// built on it is confidently wrong.

import type { SftpProgress, TransferJob } from "./api";
import { isDestExists } from "./filebrowser";
import type { MessageKey } from "./i18n/messages";
import { isSyncTransferId } from "./sync";

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

/**
 * Whether the user can stop this transfer from its row (or the status bar's
 * "cancel all"). Only a transfer still in flight, and not one file of a sync run:
 * those are cancelled per run by the sync window's Stop, under the run's id — the
 * per-file `sync:<path>` id is not in the backend's cancel map at all.
 */
export function isCancellableTransfer(t: { id: string; done: boolean }): boolean {
  return !t.done && !isSyncTransferId(t.id);
}

// ── Jobs (v1.12) ─────────────────────────────────────────────────────────────
// A transfer is a job of the backend (`transfers.rs`); a window only shows the
// jobs of its sessions. These turn what the backend reports into what the panel
// footer, the status bar and the toasts say.

/** Which way a row points: to a server, from one, or between two places alike. */
export type TransferDirection = "upload" | "download" | "copy";

/**
 * One line of the transfers list: a job, or one file of a sync run. A job
 * carries the sessions it touches and how many files it has finished.
 */
export interface TransferRow extends Omit<SftpProgress, "direction"> {
  direction: TransferDirection;
  /** Sessions the job touches; absent for a file of a sync run. */
  sessions?: string[];
  /** Files finished, of `fileCount` — only when the job has more than one. */
  fileIndex?: number;
  fileCount?: number;
}

/** Up to a server, down from one — or a copy, when both sides are alike. */
export function jobDirection(job: Pick<TransferJob, "src" | "dst">): TransferDirection {
  if (job.src.local === job.dst.local) return "copy";
  return job.src.local ? "upload" : "download";
}

/** The sessions a job reads from or writes to. */
export function jobSessions(job: Pick<TransferJob, "src" | "dst">): string[] {
  return [job.src.session, job.dst.session].filter((s): s is string => s !== null);
}

/** The list row of a job. */
export function jobRow(job: TransferJob): TransferRow {
  return {
    id: job.id,
    name: job.name,
    direction: jobDirection(job),
    transferred: job.transferred,
    total: job.total,
    done: job.state !== "running",
    sessions: jobSessions(job),
    ...(job.fileCount > 1 ? { fileIndex: job.fileIndex, fileCount: job.fileCount } : {}),
  };
}

/** Whether a row belongs in the list of `sessionId`'s panel. */
export function rowTouches(row: TransferRow, sessionId: string): boolean {
  // A file of a sync run names no session: it is shown wherever the list is.
  return row.sessions === undefined || row.sessions.includes(sessionId);
}

/** What to tell the user when a job ends; null — nothing (done, or stopped by them). */
export interface JobNotice {
  kind: "error" | "info";
  key: MessageKey;
  vars: Record<string, string | number>;
}

export function jobNotice(job: TransferJob): JobNotice | null {
  if (job.state === "failed") {
    // One file, refused because the name was taken meanwhile: said as the
    // name conflict it is, not as a raw marker.
    if (job.failed === 1 && job.fileCount <= 1 && job.error && isDestExists(job.error)) {
      return {
        kind: "error",
        key: "sftp.moveConflict",
        vars: { name: job.name, dest: job.destDir },
      };
    }
    const error = job.error ?? "";
    return job.fileCount > 1 || job.failed > 1
      ? {
          kind: "error",
          key: "transfer.failedSome",
          vars: { failed: job.failed, count: Math.max(job.fileCount, job.failed), error },
        }
      : { kind: "error", key: "transfer.failedOne", vars: { name: job.name, error } };
  }
  if (job.state === "done" && job.skipped > 0) {
    return { kind: "info", key: "transfer.skipped", vars: { count: job.skipped } };
  }
  return null;
}
