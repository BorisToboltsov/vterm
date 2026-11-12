// Diagnostics, the pure part (ADR 0063): the levels and the threshold, the
// sources, how a failed backend call is graded, and the list — its facets, its
// query to the backend, its text for the clipboard. Writing an event is the
// facade's (`api/diag.ts`); a pure module returns a value and its caller writes.

import type { DiagEvent, DiagLevel } from "../types";
import type { ListFilter, ListSchema } from "../ui/listview";
import { clockOf, dayKey, JOURNAL_SOURCES } from "../notifications/journal";

/**
 * The parts of the app an event comes from: the journal's — `app` among them
 * (start-up, exit, panics, uncaught errors) — and `storage` (store files,
 * keychain), which says nothing to the user by itself. Mirror of
 * `diag::SOURCES` (gate `diag.guard`).
 */
export const DIAG_SOURCES = [...JOURNAL_SOURCES, "storage"] as const;

export type DiagSource = (typeof DIAG_SOURCES)[number];

export const isDiagSource = (v: unknown): v is DiagSource =>
  typeof v === "string" && (DIAG_SOURCES as readonly string[]).includes(v);

/** The thresholds the settings offer, the quietest first; `trace` is a development build's. */
export const THRESHOLDS = ["error", "warn", "info", "debug"] as const satisfies readonly DiagLevel[];

export type DiagThreshold = (typeof THRESHOLDS)[number];

/** Written when nothing was picked (mirror of `diag::DEFAULT_THRESHOLD`). */
export const DEFAULT_THRESHOLD: DiagThreshold = "info";

const RANK: Record<DiagLevel, number> = { error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

/** Whether an event of `level` is written at `threshold`: at it or above. */
export function passes(level: DiagLevel, threshold: DiagLevel): boolean {
  return RANK[level] <= RANK[threshold];
}

/** A threshold as the settings take it: one of the four, the default otherwise. */
export function sanitizeThreshold(v: unknown): DiagThreshold {
  return (THRESHOLDS as readonly unknown[]).includes(v) ? (v as DiagThreshold) : DEFAULT_THRESHOLD;
}

/**
 * The markers of an ordinary outcome (`error.rs`): a wrong password, a cancelled
 * login, a name already taken, a file changed under the editor. The app answers
 * each of them with a question; it is `info`, not a fault.
 */
export const EXPECTED_MARKERS = ["auth-rejected", "auth-cancelled", "dest-exists", "key-exists", "file-changed"] as const;

/** How a rejected backend call is written: `warn`, or `info` for an ordinary outcome. */
export function rejectionLevel(err: unknown): "warn" | "info" {
  const text = String(err);
  return EXPECTED_MARKERS.some((m) => text.includes(m)) ? "info" : "warn";
}

/** What a thrown value says, as an event's text: its message, else its string. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : String(err);
}

/**
 * The kinds of event the list titles in the reader's language
 * (`diag.code.<code>`): every `code` the backend (`code = "…"`) or the facade
 * (`{ code: "…" }`) writes is one of these (gate `diag.guard`). An event
 * without a code, or with one this build does not know, shows its text alone.
 */
export const DIAG_CODES = [
  "threshold",
  "size",
  "dropped",
  "started",
  "exiting",
  "panic",
  "uncaught-error",
  "unhandled-rejection",
  "command-failed",
  "webview-ready",
  "connecting",
  "connected",
  "login-refused",
  "connect-failed",
  "host-key-changed",
  "host-key-unknown",
  "server-closed",
  "session-ended",
  "reconnect-wait",
  "reconnected",
  "reconnect-gave-up",
  "session-closed",
  "shell-started",
  "shell-exited",
  "shell-failed",
  "window-opened",
  "window-not-opened",
  "window-reopened",
  "window-closed",
  "handoff-begun",
  "handoff-rolled-back",
  "handoff-not-taken",
  "store-quarantined",
  "store-at-risk",
  "keychain-failed",
  "update-check",
  "update-download",
  "update-verified",
  "update-unverified",
  "update-handed",
  "updated",
  "update-not-installed",
  "update-no-result",
  "webview2-missing",
  "webview2-cached",
  "webview2-unpacked",
  "webview2-unpack-failed",
  "transfer-started",
  "transfer-done",
  "transfer-failed",
  "transfer-cut",
  "transfer-stopped",
  "transfer-unfinished",
  "transfers-not-discarded",
  "sync-started",
  "sync-ended",
  "sync-failed",
  "file-saved",
  "copy-saved",
  "dragout-taken",
  "dragout-refused",
  "file-user",
  "file-user-refused",
  "policy-refused",
  "local-run-refused",
  "netcheck-ended",
  "netcheck-stopped",
  "netcheck-failed",
  "poll-failed",
  "poll-back",
  "probe-unread",
  "ai-asked",
  "ai-answered",
  "ai-failed",
  "ai-exec",
  "ai-exec-refused",
  "deny-list",
  "step-confirmed",
  "step-skipped",
  "consent-given",
  "consent-declined",
] as const;

export type DiagCode = (typeof DIAG_CODES)[number];

export const isDiagCode = (v: unknown): v is DiagCode =>
  typeof v === "string" && (DIAG_CODES as readonly string[]).includes(v);

/**
 * What a coded event's title is filled with: its fields, flat and as text — a
 * threshold's `from`/`to` named as the settings name them (`thresholdName`).
 */
export function codeParams(e: DiagEvent, thresholdName: (level: string) => string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.fields ?? {})) params[k] = String(v);
  if (e.code === "threshold") {
    if (params.from) params.from = thresholdName(params.from);
    if (params.to) params.to = thresholdName(params.to);
  }
  return params;
}

/** Events a page asks for. */
export const DIAG_PAGE = 200;

/** What the backend is asked for a list filter (mirror of `diag::query::Query`). */
export interface DiagQuery {
  levels: DiagLevel[];
  sources: string[];
  servers: string[];
  text: string;
  before: number | null;
  limit: number;
}

/** The backend's query for a list filter — and the moment before which the next page starts. */
export function queryOf(filter: ListFilter, before: number | null = null, limit = DIAG_PAGE): DiagQuery {
  return {
    levels: [...(filter.facets.level ?? [])] as DiagLevel[],
    sources: [...(filter.facets.source ?? [])],
    servers: [...(filter.facets.server ?? [])],
    text: filter.text.trim(),
    before,
    limit,
  };
}

const LEVEL_ORDER: readonly DiagLevel[] = ["error", "warn", "info", "debug", "trace"];

/**
 * The list of diagnostics (ADR 0050): the filter row's facets and the days.
 * The backend narrows and counts (`diag_query`); the schema names the facets and
 * groups the page it got, newest first.
 */
export const DIAG_SCHEMA: ListSchema<DiagEvent> = {
  text: (e) => [e.text, e.server ?? "", e.source ?? ""].join(" "),
  sorts: [{ id: "time", firstDir: "desc", compare: (a, b) => a.at - b.at }],
  groups: [
    {
      id: "day",
      of: (e) => ({ key: dayKey(e.at), label: dayKey(e.at) }),
      compare: (a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0),
    },
  ],
  facets: [
    { id: "level", value: (e) => e.level, order: LEVEL_ORDER, multi: true },
    { id: "source", value: (e) => e.source ?? "", multi: true },
    { id: "server", value: (e) => e.server ?? "", multi: true },
  ],
  tie: (a, b) => a.at - b.at,
};

export const DIAG_ORDER = { sort: { key: "time", dir: "desc" as const }, group: "day" };

/** An event's fields as one line: `path=/etc/x count=3`. */
export function fieldsLine(e: DiagEvent): string {
  return Object.entries(e.fields ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}

/**
 * The events as text for the clipboard: date and time, level, where, how many
 * times, the text and its fields under it.
 */
export function diagText(
  events: readonly DiagEvent[],
  name: { source: (s: string) => string; title?: (e: DiagEvent) => string | null },
): string {
  return events
    .map((e) => {
      const where = [e.server, e.source ? name.source(e.source) : null].filter(Boolean).join(" · ");
      const head = [
        `${dayKey(e.at)} ${clockOf(e.at)}`,
        e.level.toUpperCase(),
        where,
        (e.count ?? 1) > 1 ? `×${e.count}` : "",
      ].filter(Boolean);
      const fields = fieldsLine(e);
      const title = name.title?.(e);
      const lines = [title, e.text.replace(/\n/g, "\n  ")].filter(Boolean).join("\n  ");
      return `${head.join("  ")}\n  ${lines}${fields ? `\n  ${fields}` : ""}`;
    })
    .join("\n");
}

/**
 * The sizes on disk the settings offer, in MB (mirror of `diag::SIZES_MB`):
 * the files together are no bigger, the oldest events go first.
 */
export const DIAG_SIZES_MB = [5, 10, 25, 50, 100, 250] as const;

/** The size when nothing was picked (mirror of `diag::DEFAULT_SIZE_MB`). */
export const DEFAULT_DIAG_SIZE_MB = 25;

/** A size as the settings take it: one of the offered, the default otherwise. */
export function sanitizeDiagSize(v: unknown): number {
  return (DIAG_SIZES_MB as readonly unknown[]).includes(v) ? (v as number) : DEFAULT_DIAG_SIZE_MB;
}

/** `mb` megabytes, in bytes. */
export const mbBytes = (mb: number): number => mb * 1024 * 1024;

/** The size of the files as the settings say it: `3.2 MB`, `840 KB`. */
export function sizeOf(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** A frontend error report waits this long before another one is said (ms). */
export const INTERNAL_ERROR_EVERY_MS = 60_000;

/** Whether «internal error» may be said now, the last time it was said at `last`. */
export function mayTellInternalError(last: number | null, now: number): boolean {
  return last === null || now - last >= INTERNAL_ERROR_EVERY_MS;
}
