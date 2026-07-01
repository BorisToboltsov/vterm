// Pure assembly of the session context offered to the AI assistant (Phase 17.3).
//
// The model is manual-first and tiered: by default the assistant only sees the
// current selection (or the recent output tail); attaching the whole buffer, a
// recording transcript, or host metadata are explicit opt-in toggles in AI
// settings. Whatever is collected is redacted here and shown to the user in the
// consent dialog before a single byte is sent — the actual fetching of buffer /
// selection / recording / metadata text is impure and lives in the components;
// this module only takes the already-read strings and shapes the payload.
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

/**
 * Decide which sources to include from the raw strings + chosen tiers, then
 * redact and assemble them into one labelled block. The default tier is the
 * selection when present, otherwise the recent tail; `includeBuffer` widens the
 * terminal section to the whole scrollback (and supersedes the tail).
 */
export function buildContext(raw: RawContext, s: ContextTiers): BuiltContext {
  const pieces: { source: ContextSource; text: string }[] = [];

  const selection = clean(raw.selection);
  if (selection) {
    pieces.push({ source: "selection", text: selection });
  }

  if (s.includeBuffer) {
    const buffer = clean(raw.buffer);
    if (buffer) pieces.push({ source: "buffer", text: buffer });
  } else if (!selection) {
    // Default tier with no selection: the recent output tail (labelled buffer).
    const tail = clean(raw.tail);
    if (tail) pieces.push({ source: "buffer", text: tail });
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
    return `${HEADERS[p.source]}\n${r.text}`;
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
 * Merge a built context block with the user's question into the single message
 * content sent to the broker. The context is clearly fenced so the model treats
 * it as reference material, not instructions.
 */
export function withContext(context: string, question: string): string {
  if (!context) return question;
  return `Context from my terminal session:\n\n${context}\n\n---\n\n${question}`;
}
