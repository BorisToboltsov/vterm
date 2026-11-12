// The diagnostics of a window (ADR 0063): the one facade the front end writes
// events through, and the commands that read them back. Events are batched —
// sent every half second, at once on an error, and what is left when the window
// goes — and an event below the threshold is not sent at all: the window knows
// the threshold (`setDiagThreshold`, kept by the diagnostics store from the
// backend's `window://diag`). The backend checks it again: a window is not its
// word.
//
// Never handed to an event: secrets, and content — terminal output, file text,
// prompts and answers, the clipboard, environment values (`vterm/diag-no-secret`).
// The writer masks every line besides, as a last line of defence.
//
// Outside the app — a test, a page without Tauri — there is no backend to write
// to: events are kept for `captureDiag()` and sent nowhere.

import { save } from "@tauri-apps/plugin-dialog";
import { call } from "./call";
import { errorText, passes, rejectionLevel, type DiagQuery, type DiagThreshold } from "../diag/diag";
import type { DiagEvent, DiagLevel, DiagPage, DiagState } from "../types";

/** Heard by every window: the threshold changed, or a panic was written (`diag::News`). */
export const DIAG_EVENT = "window://diag";

/** How long events wait to go in one batch (ms). */
const BATCH_MS = 500;

/** Flat values only: an object is never handed over whole. */
export type DiagFields = Record<string, string | number | boolean | null | undefined>;

/** What a window tells about an event besides its words. */
export interface DiagAbout {
  /** What kind of event it is — one of `DIAG_CODES` (`diag/diag.ts`). */
  code?: string;
  sid?: string | null;
  serverId?: string | null;
  server?: string | null;
}

/** An event as it goes to `diag_write` (mirror of `diag::FrontEvent`). */
interface Outgoing {
  level: DiagLevel;
  source: string;
  text: string;
  code?: string;
  fields?: Record<string, string | number | boolean>;
  sid?: string;
  serverId?: string;
  server?: string;
  at: number;
}

let threshold: DiagLevel = "info";
let queue: Outgoing[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let captured: Outgoing[] | null = null;

const inApp = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The threshold the backend said — what this window does not send below. */
export function setDiagThreshold(level: DiagLevel): void {
  threshold = level;
}

function flat(fields: DiagFields | undefined): Outgoing["fields"] {
  if (!fields) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Send what waits, now. */
export function flushDiag(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  // A batch that did not get there is not written: there is nowhere else to say so.
  // eslint-disable-next-line vterm/no-silent-catch -- the diagnostics cannot write their own failure: it would go through them again
  call<void>("diag_write", { events }).catch(() => undefined);
}

/** Write an event: kept in the batch when it passes the threshold. */
export function diagEvent(
  level: DiagLevel,
  source: string,
  text: string,
  fields?: DiagFields,
  about: DiagAbout = {},
): void {
  if (!passes(level, threshold)) return;
  const e: Outgoing = {
    level,
    source,
    text,
    code: about.code,
    fields: flat(fields),
    sid: about.sid ?? undefined,
    serverId: about.serverId ?? undefined,
    server: about.server ?? undefined,
    at: Date.now(),
  };
  if (captured) return void captured.push(e);
  if (!inApp()) return;
  queue.push(e);
  if (level === "error") return flushDiag();
  timer ??= setTimeout(flushDiag, BATCH_MS);
}

/** The facade: `diag.warn("files", "listing failed", { path }, { sid })`. */
export const diag = {
  error: (source: string, text: string, fields?: DiagFields, about?: DiagAbout) =>
    diagEvent("error", source, text, fields, about),
  warn: (source: string, text: string, fields?: DiagFields, about?: DiagAbout) =>
    diagEvent("warn", source, text, fields, about),
  info: (source: string, text: string, fields?: DiagFields, about?: DiagAbout) =>
    diagEvent("info", source, text, fields, about),
  debug: (source: string, text: string, fields?: DiagFields, about?: DiagAbout) =>
    diagEvent("debug", source, text, fields, about),
};

/**
 * An error dropped on purpose, written (ADR 0063): `debug` when it was
 * expected — a window already gone, an answer nobody waits for — `warn` when
 * the user lost something. `what` says what did not happen.
 */
export function swallowed(source: string, what: string, err: unknown, level: "debug" | "warn" = "debug"): void {
  diagEvent(level, source, `${what}: ${errorText(err)}`);
}

/** The same, as a handler: `.catch(swallow("windows", "the windows were not told the drag ended"))`. */
export const swallow =
  (source: string, what: string, level: "debug" | "warn" = "debug") =>
  (err: unknown): void =>
    swallowed(source, what, err, level);

/** The same, going on with `null`: `await over(files).catch(orNull("files", "the other window was not told about the files"))`. */
export const orNull =
  (source: string, what: string, level: "debug" | "warn" = "debug") =>
  (err: unknown): null => {
    swallowed(source, what, err, level);
    return null;
  };

/** A backend command was rejected (`call()`): its name, time and error — never its arguments. */
export function noteRejected(cmd: string, err: unknown, ms: number): void {
  diagEvent(rejectionLevel(err), "app", `command ${cmd} failed: ${errorText(err)}`, { command: cmd, ms }, { code: "command-failed" });
}

/**
 * A test's events: from now on kept here instead of sent, until `stop()`.
 * Each returns the events in the shape the backend would get them.
 */
export function captureDiag(): { events: () => DiagEvent[]; stop: () => void } {
  captured = [];
  const was = threshold;
  return {
    events: () =>
      (captured ?? []).map(({ at, level, source, text, code, fields, sid, serverId, server }) => ({
        at,
        level,
        source,
        text,
        code,
        fields,
        sid,
        serverId,
        server,
      })),
    stop: () => {
      captured = null;
      threshold = was;
    },
  };
}

// ── Reading back ────────────────────────────────────────────────────────────

export function diagState(): Promise<DiagState> {
  return call<DiagState>("diag_state");
}

export function diagSetLevel(level: DiagThreshold): Promise<DiagState> {
  return call<DiagState>("diag_set_level", { level });
}

/** The most the files take, in MB: made smaller, the oldest events go at once. */
export function diagSetSize(sizeMb: number): Promise<DiagState> {
  return call<DiagState>("diag_set_size", { sizeMb });
}

export function diagQuery(query: DiagQuery): Promise<DiagPage> {
  flushDiag();
  return call<DiagPage>("diag_query", { query });
}

export function diagClear(): Promise<DiagState> {
  return call<DiagState>("diag_clear");
}

/** Where the user wants the export: the system's save dialog; null — they changed their mind. */
export function pickDiagExportPath(): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10);
  return save({ defaultPath: `vterm-diagnostics-${day}.jsonl`, filters: [{ name: "JSON Lines", extensions: ["jsonl"] }] });
}

/** The files to `path`, which the user picked in the save dialog. */
export function diagExport(path: string): Promise<void> {
  flushDiag();
  return call<void>("diag_export", { path });
}

/** Show the folder in the system's file manager. */
export function diagReveal(): Promise<void> {
  return call<void>("diag_reveal");
}
