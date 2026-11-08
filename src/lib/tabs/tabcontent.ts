// What a tab held, as it is kept across a restart (v1.36, ADR 0057): its
// terminal — screen and scrollback, the commands typed, where each command's
// output ran — and its conversation with the assistant.
//
// Kept only when the user asked (`settings.restoreOutput`, off by default),
// only while tabs come back at all, and never for a production server: a slot
// holds what a tab was (`tabrestore.ts`), this holds what was printed and
// typed in it. The backend keeps the record, one file per tab
// (`tabcontent.rs`); reading it back, this module trusts nothing of it.
//
// Pure: no runes, no DOM, no storage.

import type { AiChatItem } from "../stores/aichat.svelte";
import type { SavedBlock } from "../terminal/filelinkprovider";
import type { TermSnapshot } from "../windows/tabhandoff";
import type { RestoreMode } from "./tabrestore";

/** Bumped when the record's shape changes; a record of another version is not read. */
export const CONTENT_VERSION = 1;

/**
 * Rows of scrollback kept besides the screen. The rest of a long session's
 * output is what session recordings are for; a restored terminal starts with
 * enough to see where it was.
 */
export const RESTORE_SCROLLBACK = 5000;

/** How often a window writes down the tabs whose terminal or conversation changed. */
export const CONTENT_SAVE_MS = 20_000;

const MAX_GRID = 2000;
const MAX_COMMANDS = 500;
const MAX_COMMAND = 4096;
const MAX_BLOCKS = 10_000;
const MAX_MESSAGES = 200;

/** What is kept of a tab. */
export interface TabContent {
  /** When it was written down (ms since the epoch) — said above the restored output. */
  savedAt: number;
  term: TermSnapshot | null;
  chat: AiChatItem[] | null;
}

/**
 * Whether what tab holds is written down: the user asked for it, tabs come
 * back at all, and the tab is not one of a production server — "it kept what
 * the prod session printed" is exactly what the prod flag is there to rule out.
 */
export function keepsContent(
  s: { restoreOutput: boolean; restoreTabs: RestoreMode },
  prod: boolean,
): boolean {
  return s.restoreOutput && s.restoreTabs !== "off" && !prod;
}

/**
 * The file-link notes of a terminal whose snapshot keeps only its last `kept`
 * rows of `length`: their rows counted from the first row kept, those above it
 * dropped (`FileLinks.restore` takes them only for a replay of that length).
 */
export function cutBlocks(blocks: readonly SavedBlock[], length: number, kept: number): SavedBlock[] {
  const offset = Math.max(0, length - kept);
  return blocks
    .filter((b) => b.line >= offset)
    .map((b) => ({ line: b.line - offset, cwd: b.cwd }));
}

/** One chat turn as it is written down — the fields listed here, none of the run's state. */
function savedItem(m: AiChatItem): AiChatItem {
  const out: AiChatItem = { role: m.role, content: m.content };
  if (m.sent !== undefined) out.sent = m.sent;
  if (m.withContext !== undefined) out.withContext = m.withContext;
  if (m.reasoning) out.reasoning = m.reasoning;
  if (m.elapsedMs !== undefined) out.elapsedMs = m.elapsedMs;
  if (m.usage) {
    out.usage = {};
    if (m.usage.inputTokens != null) out.usage.inputTokens = m.usage.inputTokens;
    if (m.usage.outputTokens != null) out.usage.outputTokens = m.usage.outputTokens;
  }
  return out;
}

/** The record the backend keeps for a tab. */
export function contentRecord(c: TabContent): string {
  const term = c.term && {
    cols: c.term.cols,
    rows: c.term.rows,
    data: c.term.data,
    commands: c.term.commands.slice(0, MAX_COMMANDS),
    lines: c.term.lines,
    fileBlocks: c.term.fileBlocks.slice(0, MAX_BLOCKS).map((b) => ({ line: b.line, cwd: b.cwd })),
  };
  const chat = c.chat && c.chat.length > 0 ? c.chat.slice(-MAX_MESSAGES).map(savedItem) : null;
  return JSON.stringify({ v: CONTENT_VERSION, savedAt: c.savedAt, term, chat });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const count = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max;

const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseTerm(raw: unknown): TermSnapshot | null {
  if (!isRecord(raw)) return null;
  if (!count(raw.cols, MAX_GRID) || !count(raw.rows, MAX_GRID) || typeof raw.data !== "string") return null;
  const commands = Array.isArray(raw.commands)
    ? raw.commands
        .filter((c): c is string => typeof c === "string" && c.length <= MAX_COMMAND && !c.includes("\n"))
        .slice(0, MAX_COMMANDS)
    : [];
  const lines = Number.isInteger(raw.lines) && (raw.lines as number) >= 0 ? (raw.lines as number) : 0;
  const fileBlocks = Array.isArray(raw.fileBlocks)
    ? raw.fileBlocks
        .filter(
          (b): b is SavedBlock =>
            isRecord(b) &&
            Number.isInteger(b.line) &&
            (b.line as number) >= 0 &&
            (b.cwd === null || (typeof b.cwd === "string" && b.cwd.length <= 4096)),
        )
        .slice(0, MAX_BLOCKS)
        .map((b) => ({ line: b.line, cwd: b.cwd }))
    : [];
  return { cols: raw.cols, rows: raw.rows, data: raw.data, commands, lines, fileBlocks };
}

function parseItem(raw: unknown): AiChatItem | null {
  if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant")) return null;
  if (typeof raw.content !== "string") return null;
  const out: AiChatItem = { role: raw.role, content: raw.content };
  if (typeof raw.sent === "string") out.sent = raw.sent;
  if (typeof raw.withContext === "boolean") out.withContext = raw.withContext;
  if (typeof raw.reasoning === "string" && raw.reasoning !== "") out.reasoning = raw.reasoning;
  if (nonNegative(raw.elapsedMs)) out.elapsedMs = raw.elapsedMs;
  if (isRecord(raw.usage)) {
    const usage: NonNullable<AiChatItem["usage"]> = {};
    if (nonNegative(raw.usage.inputTokens)) usage.inputTokens = raw.usage.inputTokens;
    if (nonNegative(raw.usage.outputTokens)) usage.outputTokens = raw.usage.outputTokens;
    if (Object.keys(usage).length > 0) out.usage = usage;
  }
  return out;
}

/**
 * A record read back — not trusted: it sat on disk. Another version, or
 * something that is not a record, gives null; a part that cannot be read is
 * left out (a terminal without its notes, a conversation without a turn).
 */
export function parseContent(raw: string | null): TabContent | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== CONTENT_VERSION) return null;
  const savedAt = nonNegative(value.savedAt) ? value.savedAt : 0;
  const term = parseTerm(value.term);
  const chat = Array.isArray(value.chat)
    ? value.chat
        .slice(-MAX_MESSAGES)
        .map(parseItem)
        .filter((m): m is AiChatItem => m !== null)
    : [];
  if (!term && chat.length === 0) return null;
  return { savedAt, term, chat: chat.length > 0 ? chat : null };
}

/**
 * The line written under the restored output, before the new session's: dim,
 * on a line of its own, so where the previous launch ends is never in doubt.
 */
export function separatorLine(label: string): string {
  return `\r\n\u001b[0m\u001b[2m── ${label.replace(/[\u0000-\u001f\u007f]/g, "")} ──\u001b[0m\r\n`;
}
