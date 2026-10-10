// Shared transfer state (Svelte 5 runes): what this window shows of the
// transfers under way. Two feeds, both subscribed once at the app level (see
// +page.svelte): `sftp://job` — a job of the backend (`applyJob`), and
// `sftp://progress` — one file of a sync run (`applyProgress`). The SFTP panel
// and the status-bar indicator read from here, so progress stays visible even
// when the panel is collapsed.
//
// A job is the backend's, not this window's (v1.12, ADR 0025): nothing here
// starts one, awaits one or keeps it alive. A row is what the backend last said
// about a job of one of this window's sessions — which is why a tab can leave
// for another window with its transfer under way.

import type { TransferJob } from "../api";
import {
  jobRow,
  pushSample,
  rowTouches,
  sampleRate,
  type RateSample,
  type TransferRow,
} from "../transfer";
import { touchDir } from "./dockstate.svelte";

export const transfersState = $state<{
  map: Record<string, TransferRow>;
  /**
   * Observed speed per transfer id (bytes/s), or null while it is not yet
   * knowable. Derived here rather than in the panel so the status-bar indicator
   * and the SFTP panel quote the same number, and so a collapsed panel does not
   * lose the sample history that a reopened one needs.
   */
  rates: Record<string, number | null>;
}>({ map: {}, rates: {} });

/** Active (not-yet-finished) transfers, plus those still in their linger window. */
export const transferList = (): TransferRow[] => Object.values(transfersState.map);

/** The rows the panel of `sessionId` lists: its own jobs, and the files of a sync run. */
export function transfersOf(sessionId: string): TransferRow[] {
  return transferList().filter((row) => rowTouches(row, sessionId));
}

// Pending "remove after done" timers, keyed by transfer id.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
// Sliding rate-sample history, keyed by transfer id (see transfer.ts).
const samples = new Map<string, RateSample[]>();
/** How long a finished transfer lingers before it disappears (ms). */
export const DONE_LINGER_MS = 1500;

/** Clock for rate samples; overridable in tests. */
let now = (): number => Date.now();
/** Test seam: swap the clock used for rate sampling. */
export function setTransferClock(fn: () => number): void {
  now = fn;
}

/**
 * What the backend says of a job. When it has ended — however — the folder it
 * was writing into is marked changed, so a panel showing it re-lists once: the
 * panel that asked for the transfer may be gone by then (v1.0.42), and since
 * v1.12 nobody waits for a transfer at all.
 */
export function applyJob(job: TransferJob): void {
  applyProgress(jobRow(job));
  if (job.state !== "running" && job.dst.session) touchDir(job.dst.session, job.destDir);
}

/**
 * A tab left this window (closed, or handed to another one): forget the rows
 * that touch only sessions no longer here. A copy between two sessions stays
 * while the other one's tab is still in this window.
 */
export function dropTransfersOf(sessionId: string, here: (sessionId: string) => boolean): void {
  for (const row of transferList()) {
    if (!row.sessions?.includes(sessionId)) continue;
    if (!row.sessions.some((s) => s !== sessionId && here(s))) removeTransfer(row.id);
  }
}

/** Record a progress update; finished transfers auto-clear after a short linger. */
export function applyProgress(p: TransferRow): void {
  transfersState.map = { ...transfersState.map, [p.id]: p };
  if (p.done) {
    // A finished transfer has no speed — showing the last window average next to
    // "100%" reads as though bytes were still moving.
    samples.delete(p.id);
    transfersState.rates = { ...transfersState.rates, [p.id]: null };
  } else {
    const next = pushSample(samples.get(p.id) ?? [], now(), p.transferred);
    samples.set(p.id, next);
    transfersState.rates = { ...transfersState.rates, [p.id]: sampleRate(next) };
  }
  const existing = timers.get(p.id);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(p.id);
  }
  if (p.done) {
    timers.set(
      p.id,
      setTimeout(() => removeTransfer(p.id), DONE_LINGER_MS),
    );
  }
}

/** Drop a transfer immediately (and cancel its linger timer). */
export function removeTransfer(id: string): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
  samples.delete(id);
  const { [id]: _drop, ...rest } = transfersState.map;
  const { [id]: _dropRate, ...restRates } = transfersState.rates;
  transfersState.map = rest;
  transfersState.rates = restRates;
}

/** Clear everything (used by tests). */
export function clearTransfers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  samples.clear();
  transfersState.map = {};
  transfersState.rates = {};
}

export interface TransferSummary {
  /** Number of in-flight (not done) transfers. */
  active: number;
  /** Aggregate percent across all listed transfers (0–100). */
  pct: number;
  /** "upload" when any upload is listed, else "download", else "copy"; null when idle. */
  direction: "upload" | "download" | "copy" | null;
}

/**
 * Summarise a list of transfers for the compact status-bar indicator. Percent is
 * the bytes/files weighted average; an upload in the set wins the arrow.
 */
export function aggregateTransfers(list: TransferRow[]): TransferSummary {
  const active = list.filter((t) => !t.done).length;
  let transferred = 0;
  let total = 0;
  for (const t of list) {
    transferred += t.transferred;
    total += t.total;
  }
  const pct = total > 0 ? Math.round((transferred / total) * 100) : 0;
  const has = (d: TransferRow["direction"]) => list.some((t) => t.direction === d);
  const direction =
    list.length === 0 ? null : has("upload") ? "upload" : has("download") ? "download" : "copy";
  return { active, pct, direction };
}
