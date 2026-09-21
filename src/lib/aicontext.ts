// Pure assembly of the session context offered to the AI assistant (Phase 17.3).
//
// The model is manual-first and tiered: by default the assistant only sees the
// current selection (or the recent output tail); attaching the whole buffer, a
// recording transcript, or host metadata are explicit opt-in toggles in AI
// settings. A selection is the narrower intent and wins over the buffer: the user
// who marked ten lines did not mean "and the whole scrollback too". Whatever is
// collected is redacted here and shown to the user in the consent dialog before a
// single byte is sent — the actual fetching of buffer / selection / recording /
// metadata text is impure and lives in the components; this module only takes the
// already-read strings and shapes the payload.
//
// DOM/network-free → unit-tested directly.

import { redactSecrets } from "./redact";

/** Opt-in context tiers that widen the base (selection / recent tail). Chosen
 *  per-chat in the Context popover (default from `settings.ai`). */
export interface ContextTiers {
  includeBuffer: boolean;
  includeRecording: boolean;
  includeMetadata: boolean;
}

/** Default tail size when no selection exists and the whole buffer isn't attached. */
export const DEFAULT_TAIL_LINES = 200;

/** Which kinds of context contributed to a payload (for the consent summary). */
export type ContextSource = "selection" | "buffer" | "recording" | "metadata";

/** Raw (pre-redaction) strings read from the live session by the caller. */
export interface RawContext {
  /** Current terminal selection, if any. */
  selection?: string;
  /** The full terminal scrollback (only attached when `includeBuffer`). */
  buffer?: string;
  /** The recent output tail — the default when there is no selection. */
  tail?: string;
  /** Transcript of the active recording (only when `includeRecording`). */
  recording?: string;
  /** Host metadata block: OS / hostname / kernel (only when `includeMetadata`). */
  metadata?: string;
}

/** A built, redacted context payload ready for consent + sending. */
export interface BuiltContext {
  /** The redacted, section-labelled text block (empty when nothing collected). */
  text: string;
  /** Line count of the payload — the "send N lines" figure in the consent dialog. */
  lines: number;
  /** How many secrets were masked across all sections. */
  redactions: number;
  /** Which sources contributed, in payload order. */
  sources: ContextSource[];
}

// Canonical English section headers — this is data fed to the model (stable,
// model-friendly), not UI chrome, so it is intentionally not localized.
const HEADERS: Record<ContextSource, string> = {
  selection: "### Terminal selection",
  buffer: "### Terminal buffer",
  recording: "### Session recording",
  metadata: "### Host metadata",
};

function clean(s: string | undefined): string {
  return (s ?? "").replace(/\s+$/u, "");
}

/** Line count of a block as it would be sent (a trailing newline is not a line). */
export function textLines(text: string): number {
  const body = clean(text);
  return body ? body.split("\n").length : 0;
}

/** What fills the terminal slot of the payload. */
export type TerminalSlot = "attachment" | "selection" | "buffer" | "tail";

/**
 * The one rule for the terminal slot, narrowest first: an explicitly attached
 * block, else the live selection, else the whole scrollback when `includeBuffer`
 * is on, else the recent tail. Shared by {@link buildContext} and the caption
 * next to the paperclip, so what the caption promises is what gets built.
 */
export function terminalSlot(i: { attached: boolean; selection: boolean; includeBuffer: boolean }): TerminalSlot {
  if (i.attached) return "attachment";
  if (i.selection) return "selection";
  return i.includeBuffer ? "buffer" : "tail";
}

/** One piece of the "what will be sent" caption: an i18n key plus its params. */
export interface SummaryPart {
  key:
    | "ai.context.slot.attachment"
    | "ai.context.slot.selection"
    | "ai.context.slot.buffer"
    | "ai.context.slot.tail"
    | "ai.context.plusRecording"
    | "ai.context.plusMetadata";
  params?: Record<string, string>;
}

/**
 * What a send with the paperclip on would carry, for the caption beside it.
 * Mirrors {@link buildContext}: the recording is promised only when one is
 * running (the tier adds nothing otherwise), and an invisible stale selection
 * shows up here as "selection · N lines" instead of surfacing only in consent.
 */
export function contextSummary(i: {
  attached: boolean;
  selectionLines: number;
  tiers: ContextTiers;
  hasRecording: boolean;
}): SummaryPart[] {
  const slot = terminalSlot({
    attached: i.attached,
    selection: i.selectionLines > 0,
    includeBuffer: i.tiers.includeBuffer,
  });
  const parts: SummaryPart[] = [
    slot === "selection"
      ? { key: "ai.context.slot.selection", params: { count: String(i.selectionLines) } }
      : slot === "tail"
        ? { key: "ai.context.slot.tail", params: { count: String(DEFAULT_TAIL_LINES) } }
        : { key: `ai.context.slot.${slot}` },
  ];
  if (i.tiers.includeRecording && i.hasRecording) parts.push({ key: "ai.context.plusRecording" });
  if (i.tiers.includeMetadata) parts.push({ key: "ai.context.plusMetadata" });
  return parts;
}

/** A block the user attached explicitly (the composer chip): its own header. */
export interface AttachedBlock {
  /** Canonical English section header, e.g. "Terminal selection". */
  header: string;
  /** Raw (pre-redaction) text. */
  text: string;
}

/**
 * Decide which sources to include from the raw strings + chosen tiers, then
 * redact and assemble them into one labelled block. The terminal slot holds one
 * thing, narrowest first: an explicitly attached block, else the live selection,
 * else the whole scrollback when `includeBuffer` is on, else the recent tail.
 * Recording and metadata are separate tiers and add to whichever it was.
 */
export function buildContext(raw: RawContext, s: ContextTiers, attached?: AttachedBlock): BuiltContext {
  const pieces: { source: ContextSource; text: string; header?: string }[] = [];

  const block = clean(attached?.text);
  const selection = clean(raw.selection);
  const slot = terminalSlot({ attached: !!block, selection: !!selection, includeBuffer: s.includeBuffer });
  if (slot === "attachment") {
    // Reported as buffer-derived: the consent summary lists sources, not entry points.
    pieces.push({ source: "buffer", text: block, header: `### ${attached?.header}` });
  } else if (slot === "selection") {
    pieces.push({ source: "selection", text: selection });
  } else {
    // The whole scrollback when the tier is on, else the recent tail (both labelled buffer).
    const text = clean(slot === "buffer" ? raw.buffer : raw.tail);
    if (text) pieces.push({ source: "buffer", text });
  }

  if (s.includeRecording) {
    const recording = clean(raw.recording);
    if (recording) pieces.push({ source: "recording", text: recording });
  }

  if (s.includeMetadata) {
    const metadata = clean(raw.metadata);
    if (metadata) pieces.push({ source: "metadata", text: metadata });
  }

  let redactions = 0;
  const sections = pieces.map((p) => {
    const r = redactSecrets(p.text);
    redactions += r.count;
    return `${p.header ?? HEADERS[p.source]}\n${r.text}`;
  });

  const text = sections.join("\n\n");
  return {
    text,
    lines: text ? text.split("\n").length : 0,
    redactions,
    sources: pieces.map((p) => p.source),
  };
}

/**
 * Shape a single block of already-collected text (a staged diff for the commit
 * drafter) as a {@link BuiltContext}, through the same redaction and the same
 * consent preview. The label becomes the `###` section header, which the core
 * prompt tells the model to treat as untrusted data.
 */
export function buildRawContext(text: string, label: string): BuiltContext {
  return buildContext({}, NO_TIERS, { header: label, text });
}

const NO_TIERS: ContextTiers = { includeBuffer: false, includeRecording: false, includeMetadata: false };

/**
 * Merge a built context block with the user's question into the single message
 * content sent to the broker. The context is clearly fenced so the model treats
 * it as reference material, not instructions.
 */
export function withContext(context: string, question: string): string {
  if (!context) return question;
  return `Context from my terminal session:\n\n${context}\n\n---\n\n${question}`;
}
