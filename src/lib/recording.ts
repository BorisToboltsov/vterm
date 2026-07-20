// Pure helpers for session recordings (ADR 0003 — testable without DOM).
//
// Recordings are asciicast v2 files (NDJSON: a header line then `[t,"o"|"i",data]`
// event lines). The backend writes them; here we parse them and derive a clean
// plain-text transcript suitable for feeding to an AI (e.g. "turn this session
// into install instructions"). The transcript is built from the *output* stream
// (which already contains the echoed commands) with ANSI stripped and carriage-
// return redraws collapsed, so it reads like the session the user saw.

import { stripAnsi } from "./jsonlog";
import type { RecordingMeta } from "./types";

/** vterm-specific session metadata stored in the asciicast header's `vterm` key. */
export interface VtermMeta {
  recordMode?: string;
  startedAt?: number;
  endedAt?: number;
  hostname?: string;
  ip?: string;
  connectedHost?: string;
  port?: number;
  username?: string;
  os?: string;
  kernel?: string;
  serverTime?: string;
  appVersion?: string;
}

export interface CastHeader {
  version?: number;
  width?: number;
  height?: number;
  timestamp?: number;
  title?: string;
  /** Server/host the session was recorded on (survives a title rename). */
  server?: string;
  /** Free-form description set when saving the recording. */
  description?: string;
  /**
   * vterm extension flag. `false` marks a synthetic-timing recording (commands /
   * fullNoTiming modes) whose pace is artificial rather than real keystroke
   * timing — the player slows such recordings down (see `playbackSpeeds`).
   * Absent on older recordings → treated as real-timed.
   */
  timed?: boolean;
  /** Host/session metadata (see `VtermMeta`). */
  vterm?: VtermMeta;
}

export interface CastEvent {
  time: number;
  kind: "o" | "i";
  data: string;
}

/** Parse asciicast v2 content into its header and event list (junk lines skipped). */
export function parseCast(content: string): { header: CastHeader | null; events: CastEvent[] } {
  let header: CastHeader | null = null;
  const events: CastEvent[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(v) && v.length >= 3 && typeof v[0] === "number") {
      events.push({ time: v[0], kind: v[1] === "i" ? "i" : "o", data: String(v[2]) });
    } else if (v && typeof v === "object" && "version" in v) {
      header = v as CastHeader;
    }
  }
  return { header, events };
}

/**
 * Clean a raw output stream into readable text: strip ANSI, normalise CRLF,
 * collapse carriage-return redraws (progress bars/prompts) to their final state,
 * drop stray control chars, and squeeze long blank runs.
 */
function cleanStream(raw: string): string {
  if (!raw) return "";
  const normalized = stripAnsi(raw).replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").map((line) => {
    const parts = line.includes("\r") ? line.split("\r") : [line];
    return parts[parts.length - 1].replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** One typed line, ANSI- and control-stripped and trimmed (for command export). */
function cleanLine(s: string): string {
  return stripAnsi(s)
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

/**
 * Reconstruct a clean plain-text transcript from a recording's output stream
 * (what the user saw). Returns "" for an empty/invalid cast.
 */
export function extractTranscript(content: string): string {
  const { events } = parseCast(content);
  return cleanStream(events.filter((e) => e.kind === "o").map((e) => e.data).join(""));
}

/**
 * True when input events are committed command lines — "commands"-mode recordings
 * store each command as one `i` event with no embedded newline. Full/keystroke
 * recordings embed Enter (`\r`) in the `i` stream, so at least one `i` has a
 * newline. (No input events at all → treat as keystroke-style.)
 */
function inputsArePerLine(events: CastEvent[]): boolean {
  const inputs = events.filter((e) => e.kind === "i");
  return inputs.length > 0 && inputs.every((e) => !/[\r\n]/.test(e.data));
}

/** Split a keystroke `i` stream into committed command lines (on Enter). */
function splitKeystrokeCommands(events: CastEvent[]): string[] {
  const cmds: string[] = [];
  let buf = "";
  for (const e of events) {
    if (e.kind !== "i") continue;
    buf += e.data;
    let nl: number;
    while ((nl = buf.search(/[\r\n]/)) >= 0) {
      const line = cleanLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (line) cmds.push(line);
    }
  }
  const tail = cleanLine(buf);
  if (tail) cmds.push(tail);
  return cmds;
}

/**
 * The commands the user typed, one per line, extracted from input events.
 * Cleanest for "commands"-mode recordings (each `i` is a committed line); for
 * full keystroke recordings it's a best-effort split on Enter.
 */
export function extractCommands(content: string): string {
  const { events } = parseCast(content);
  if (inputsArePerLine(events)) {
    return events
      .filter((e) => e.kind === "i")
      .map((e) => cleanLine(e.data))
      .filter((c) => c)
      .join("\n");
  }
  return splitKeystrokeCommands(events).join("\n");
}

// ── Session metadata (for export headers) ───────────────────────────────────────

/** Format an epoch-seconds timestamp as `YYYY-MM-DD HH:MM:SS UTC` (deterministic). */
function formatDateTime(epochSecs: number): string {
  return `${new Date(epochSecs * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Ordered, human-readable session metadata for a recording's export header:
 * server, host, address, user, OS, kernel, start/end/duration, mode, app version.
 * Only present fields are returned. The title is omitted (it heads the document).
 */
export function sessionMetaPairs(content: string): [string, string][] {
  const { header } = parseCast(content);
  if (!header) return [];
  const v = header.vterm ?? {};
  const started = v.startedAt ?? header.timestamp ?? 0;
  const ended = v.endedAt ?? 0;
  const pairs: [string, string][] = [];
  const add = (label: string, val: string | number | undefined) => {
    const s = val == null ? "" : String(val).trim();
    if (s) pairs.push([label, s]);
  };
  add("Server", header.server);
  add("Host", v.hostname);
  add("Address", v.connectedHost ? `${v.connectedHost}${v.port ? `:${v.port}` : ""}` : "");
  add("IP", v.ip);
  add("User", v.username);
  add("OS", v.os);
  add("Kernel", v.kernel);
  add("Started", started ? formatDateTime(started) : "");
  add("Ended", ended ? formatDateTime(ended) : "");
  if (started && ended && ended >= started) add("Duration", formatTime(ended - started));
  add("Mode", v.recordMode);
  add("App", v.appVersion ? `vterm ${v.appVersion}` : "");
  return pairs;
}

/**
 * Session metadata as `#`-comment lines (prepended to the transcript / commands
 * text exports). Empty when there's no header; trailing blank line separates it.
 */
export function metadataComment(content: string): string {
  const pairs = sessionMetaPairs(content);
  if (pairs.length === 0) return "";
  return `${pairs.map(([k, val]) => `# ${k}: ${val}`).join("\n")}\n\n`;
}

/** A code fence long enough to wrap `body` even if it contains backtick runs. */
function fence(body: string): string {
  const longest = (body.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Wrap `s` as an inline code span, widening the backticks if it contains any. */
function inlineCode(s: string): string {
  const longest = (s.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  const ticks = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : "";
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

/** Split a recording's events into `{cmd, out}` blocks (one per typed command). */
function commandBlocks(events: CastEvent[]): { cmd: string; out: string }[] {
  const perLine = inputsArePerLine(events);
  const blocks: { cmd: string; out: string }[] = [];
  let buf = "";
  for (const e of events) {
    if (e.kind === "i") {
      if (perLine) {
        const cmd = cleanLine(e.data);
        if (cmd) blocks.push({ cmd, out: "" });
      } else {
        buf += e.data;
        let nl: number;
        while ((nl = buf.search(/[\r\n]/)) >= 0) {
          const line = cleanLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (line) blocks.push({ cmd: line, out: "" });
        }
      }
    } else if (blocks.length) {
      blocks[blocks.length - 1].out += e.data;
    }
  }
  if (!perLine) {
    const tail = cleanLine(buf);
    if (tail) blocks.push({ cmd: tail, out: "" });
  }
  return blocks;
}

/** Clean a command block's output: strip echoed command + trailing prompt (per-line). */
function blockOutput(b: { cmd: string; out: string }, perLine: boolean, isLast: boolean): string {
  let out = cleanStream(b.out);
  if (perLine) {
    // Commands-mode output carries the echoed command on its first line and — for
    // every command but the last — the next shell prompt on its last line.
    const lines = out.split("\n");
    if (lines[0] === b.cmd) lines.shift();
    if (!isLast && lines.length) lines.pop();
    out = lines.join("\n").trimEnd();
  }
  return out;
}

/**
 * A Markdown "runbook": a metadata header, then each typed command as a numbered
 * heading (monospaced) followed by its output in a fenced `text` block — the
 * AI-friendliest, human-readable export. Returns "" when there are no commands.
 */
export function extractMarkdown(content: string): string {
  const { events, header } = parseCast(content);
  const perLine = inputsArePerLine(events);
  const blocks = commandBlocks(events);
  if (blocks.length === 0) return "";

  const title = header?.title || header?.server || "Session recording";
  const lines: string[] = [`# ${title} — session recording`, ""];
  for (const [k, val] of sessionMetaPairs(content)) lines.push(`- **${k}:** ${val}`);
  const description = header?.description?.trim();
  if (description) lines.push("", `> ${description.replace(/\n/g, "\n> ")}`);
  lines.push("", "---");

  const body = blocks
    .map((b, i) => {
      const heading = `## ${i + 1}. ${inlineCode(b.cmd)}`;
      const out = blockOutput(b, perLine, i === blocks.length - 1);
      if (!out) return `${heading}\n`;
      const f = fence(out);
      return `${heading}\n\n${f}text\n${out}\n${f}\n`;
    })
    .join("\n");

  return `${lines.join("\n")}\n\n${body}`;
}

/** Total duration of a recording in seconds (the last event's timestamp). */
export function castDuration(content: string): number {
  const { events } = parseCast(content);
  return events.length ? events[events.length - 1].time : 0;
}

/**
 * Concatenated output (`o`) data of every event at or before time `t`. Used by
 * the player to seek: the terminal state at any point is "reset + write all
 * output up to that point". Events are time-ordered, so we stop at the first
 * later one.
 */
export function outputUpTo(events: CastEvent[], t: number): string {
  let out = "";
  for (const e of events) {
    if (e.time > t) break;
    if (e.kind === "o") out += e.data;
  }
  return out;
}

/** One column of the player's activity strip. */
export interface ActivityBucket {
  /** Output volume as a fraction of the busiest bucket, 0…1. */
  level: number;
  /** Stands out sharply against the rest of the recording. */
  burst: boolean;
}

/**
 * Output density over time, as `count` equal time slices (Phase 42). The player
 * draws this behind the scrubber so a half-hour recording stops looking like a
 * half-hour of empty track: the dips are where nobody was there, the peaks are
 * where something happened.
 *
 * Only `o` (output) events are weighed, by byte count. Input events are a
 * keystroke each — counting them would make a slice where someone typed one
 * command outweigh a slice where a build scrolled past.
 *
 * Levels are log-scaled, not linear. A single `cat` of a large file is a couple
 * of orders of magnitude above ordinary shell chatter; on a linear scale it
 * pins one column at full height and flattens every other one to invisible,
 * which is precisely the flat bar this replaces.
 */
export function activityBuckets(
  events: CastEvent[],
  count: number,
  duration?: number,
): ActivityBucket[] {
  const n = Math.max(1, Math.floor(count));
  const empty = (): ActivityBucket[] => Array.from({ length: n }, () => ({ level: 0, burst: false }));
  const span = duration ?? (events.length ? events[events.length - 1].time : 0);
  if (!(span > 0)) return empty();

  const bytes = new Array<number>(n).fill(0);
  for (const e of events) {
    if (e.kind !== "o" || e.time < 0) continue;
    const i = Math.min(n - 1, Math.floor((e.time / span) * n));
    bytes[i] += e.data.length;
  }

  const max = Math.max(...bytes);
  if (max <= 0) return empty();

  // Burst = far above the typical busy slice. Measured against the median of the
  // non-empty slices so long idle stretches (the common case in a session
  // recording) do not drag the reference down and mark everything a burst.
  const busy = bytes.filter((b) => b > 0).sort((a, b) => a - b);
  const median = busy[Math.floor(busy.length / 2)];
  const scale = Math.log1p(max);

  return bytes.map((b) => ({
    level: b > 0 ? Math.log1p(b) / scale : 0,
    burst: b > 0 && b >= median * 4,
  }));
}

/**
 * Playback speed presets and the initial selection for a recording. Real-timed
 * recordings replay at their captured pace, so they use the normal scale
 * (default 1×). Synthetic-timing recordings (`header.timed === false` —
 * commands / fullNoTiming) have no real pacing: their commands are "typed out"
 * at a fixed synthetic step, which reads best slowed down, so the whole scale is
 * shifted one notch slower and playback starts at half speed. Older recordings
 * without the flag are treated as real-timed.
 */
export function playbackSpeeds(header: CastHeader | null): { speeds: number[]; initial: number } {
  if (header?.timed === false) return { speeds: [0.25, 0.5, 1, 2], initial: 0.5 };
  return { speeds: [0.5, 1, 2, 4], initial: 1 };
}

/** Format a duration in seconds as `M:SS` (or `H:MM:SS` past an hour). */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  const base = `${mm}:${String(sec).padStart(2, "0")}`;
  return h ? `${h}:${base}` : base;
}

// ── Library: search + sort (pure, for RecordingsPanel) ──────────────────────────

/** ISO `YYYY-MM-DD` (UTC) of a recording's start time, or "" when absent. */
export function recordingDateISO(timestamp: number): string {
  return timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 10) : "";
}

/**
 * Case-insensitive filter over a recording's title, description, server, filename
 * and ISO date — so users can search by name, note, server, file or `2026-06-24`.
 * Empty query returns everything.
 */
export function filterRecordings(items: RecordingMeta[], query: string): RecordingMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((r) =>
    `${r.title} ${r.description} ${r.server} ${r.path} ${recordingDateISO(r.timestamp)}`
      .toLowerCase()
      .includes(q),
  );
}

export type RecordingSortKey = "date" | "name" | "size";
export type SortDir = "asc" | "desc";

/** One level of a multi-key sort. */
export interface SortCriterion {
  key: RecordingSortKey;
  dir: SortDir;
}

/** Compare two recordings on a single key (ascending). */
function compareBy(a: RecordingMeta, b: RecordingMeta, key: RecordingSortKey): number {
  if (key === "size") return a.size - b.size;
  if (key === "name") return a.title.localeCompare(b.title);
  return a.timestamp - b.timestamp;
}

/**
 * Multi-key sort: criteria are applied in order (first = primary), so you can
 * sort by e.g. server then date then size at once. Empty criteria → original
 * order (a fresh copy). Does not mutate the input.
 */
export function sortRecordingsBy(
  items: RecordingMeta[],
  criteria: SortCriterion[],
): RecordingMeta[] {
  if (criteria.length === 0) return [...items];
  return [...items].sort((a, b) => {
    for (const { key, dir } of criteria) {
      const c = compareBy(a, b, key);
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

/** Single-key sort (convenience over `sortRecordingsBy`). */
export function sortRecordings(
  items: RecordingMeta[],
  key: RecordingSortKey,
  dir: SortDir,
): RecordingMeta[] {
  return sortRecordingsBy(items, [{ key, dir }]);
}
