// The diagnostics in this window (ADR 0063). The files are the backend's; a
// window keeps the threshold — so that its facade does not send what would not
// be written — and, while Settings → Journal shows the layer, a page of events.
//
// It also hears what went wrong where nothing caught it: an uncaught error and
// an unhandled rejection of this window are `error` events, and a panic the
// backend wrote is told by the main window. Either is said as one message —
// «internal error, see the journal» — once a minute at most.

import { listen } from "@tauri-apps/api/event";
import {
  DIAG_EVENT,
  diag,
  type DiagAbout,
  diagClear,
  diagQuery,
  diagSetLevel,
  diagSetSize,
  diagState as readDiagState,
  flushDiag,
  setDiagThreshold,
} from "../api/diag";
import {
  DEFAULT_DIAG_SIZE_MB,
  errorText,
  mayTellInternalError,
  queryOf,
  sanitizeDiagSize,
  sanitizeThreshold,
  type DiagThreshold,
} from "../diag/diag";
import { t } from "../i18n";
import type { DiagEvent, DiagNews, DiagPage, DiagState } from "../types";
import { NO_FILTER, type ListFilter } from "../ui/listview";
import { serverOf } from "../notifications/journal";
import { findTab } from "./tabs.svelte";
import { notifyError } from "./toasts.svelte";

/** The session an event happened in, and its server as the journal names it. */
export function aboutSession(sessionId: string | null | undefined): DiagAbout {
  if (!sessionId) return {};
  const { serverId, server } = serverOf(findTab(sessionId));
  return { sid: sessionId, serverId, server };
}

export const diagState = $state<{
  /** The threshold in force: what is written. */
  level: DiagThreshold;
  /** The most the files take, in MB. */
  sizeMb: number;
  /** The files as the backend last said: size, why a write failed, the folder. */
  files: DiagState | null;
  /** The page on hand, newest first; empty until the layer is shown. */
  events: DiagEvent[];
  more: boolean;
  counts: DiagPage["counts"];
  total: number;
  unreadable: number;
  /** What the list is narrowed to; kept while the window lives. */
  filter: ListFilter;
  loading: boolean;
  /** Why the last read failed; null — it did not. */
  failed: string | null;
}>({
  level: "info",
  sizeMb: DEFAULT_DIAG_SIZE_MB,
  files: null,
  events: [],
  more: false,
  counts: {},
  total: 0,
  unreadable: 0,
  filter: NO_FILTER,
  loading: false,
  failed: null,
});

let panicsSeen: number | null = null;
let toldAt: number | null = null;

function heardLevel(level: unknown): void {
  const next = sanitizeThreshold(level);
  diagState.level = next;
  setDiagThreshold(next);
}

/** Say «internal error» — once a minute at most. */
function tellInternalError(): void {
  const now = Date.now();
  if (!mayTellInternalError(toldAt, now)) return;
  toldAt = now;
  notifyError(t("diag.internalError"), { source: "app" });
}

function heardNews(news: DiagNews, main: boolean): void {
  heardLevel(news.level);
  diagState.sizeMb = sanitizeDiagSize(news.sizeMb);
  // The first answer is where the count stands: what came before was not this window's to tell.
  if (panicsSeen !== null && news.panics > panicsSeen && main) tellInternalError();
  panicsSeen = news.panics;
}

/**
 * Hear the diagnostics in this window: the threshold, the backend's panics (the
 * main window tells them), this window's uncaught errors. Returns the way to stop.
 */
export function startDiag(main: boolean): () => void {
  panicsSeen = null;
  let stop: (() => void) | null = null;
  let stopped = false;
  listen<DiagNews>(DIAG_EVENT, (e) => heardNews(e.payload, main))
    .then((un) => (stopped ? un() : (stop = un)))
    .catch((err) => diag.warn("app", `diagnostics events not heard: ${errorText(err)}`));
  readDiagState()
    .then((s) => {
      diagState.files = s;
      heardNews({ level: s.level, sizeMb: s.sizeMb, panics: s.panics }, main);
    })
    .catch((err) => diag.warn("app", `diagnostics state not read: ${errorText(err)}`));

  const onError = (e: ErrorEvent) => {
    const at = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined;
    diag.error("app", `uncaught error: ${errorText(e.error ?? e.message)}`, { at, stack: stackOf(e.error) });
    tellInternalError();
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    diag.error("app", `unhandled rejection: ${errorText(e.reason)}`, { stack: stackOf(e.reason) });
    tellInternalError();
  };
  const onHide = () => flushDiag();
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", onHide);
  return () => {
    stopped = true;
    stop?.();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("pagehide", onHide);
    flushDiag();
  };
}

/** The top of a stack, for the event: where it was thrown, not the whole trace. */
function stackOf(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  return err.stack.split("\n").slice(0, 6).join("\n");
}

/** The user picked a threshold: in force at once, in every window. */
export async function setDiagLevel(level: DiagThreshold): Promise<void> {
  const s = await diagSetLevel(level);
  diagState.files = s;
  heardLevel(s.level);
}

/** The user picked a size: in force at once, the oldest events gone if it is smaller. */
export async function setDiagSize(sizeMb: number): Promise<void> {
  const s = await diagSetSize(sizeMb);
  diagState.files = s;
  diagState.sizeMb = sanitizeDiagSize(s.sizeMb);
}

let seq = 0;

/** Read the newest page for the filter on hand; an older answer than the last asked is dropped. */
export async function loadDiag(filter: ListFilter = diagState.filter): Promise<void> {
  diagState.filter = filter;
  const mine = ++seq;
  diagState.loading = true;
  try {
    const [page, files] = await Promise.all([diagQuery(queryOf(filter)), readDiagState()]);
    if (mine !== seq) return;
    diagState.events = page.events;
    diagState.more = page.more;
    diagState.counts = page.counts;
    diagState.total = page.total;
    diagState.unreadable = page.unreadable;
    diagState.files = files;
    diagState.failed = null;
  } catch (err) {
    if (mine === seq) diagState.failed = errorText(err);
  } finally {
    if (mine === seq) diagState.loading = false;
  }
}

/** The next, older page under the one on hand. */
export async function loadOlderDiag(): Promise<void> {
  const last = diagState.events.at(-1);
  if (!last || !diagState.more) return;
  const mine = ++seq;
  diagState.loading = true;
  try {
    const page = await diagQuery(queryOf(diagState.filter, last.at));
    if (mine !== seq) return;
    diagState.events = [...diagState.events, ...page.events];
    diagState.more = page.more;
    diagState.failed = null;
  } catch (err) {
    if (mine === seq) diagState.failed = errorText(err);
  } finally {
    if (mine === seq) diagState.loading = false;
  }
}

/** Every file of the diagnostics gone; the threshold stays. */
export async function clearDiag(): Promise<void> {
  diagState.files = await diagClear();
  await loadDiag();
}
