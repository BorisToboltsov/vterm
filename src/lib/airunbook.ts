// Pure helpers for turning a session recording into a runbook / deployment plan
// (Phase 17.5, opt-in assistant). RecordingsPanel reads a recording, extracts its
// transcript (recording.ts `extractTranscript`), and asks the AI to write an
// ordered plan. As with the chat, nothing leaves the machine until the transcript
// is redacted and the user confirms in the consent dialog — so the redaction +
// consent shaping lives here (DOM/network-free, unit-tested), while the streaming
// itself is impure and stays in the component.

import { redactSecrets } from "./redact";
import type { BuiltContext } from "./aicontext";

// The instruction is the active runbook prompt (`settings.ai.prompts.runbook`,
// resolved via `resolvePromptContent` in ai.ts). The user message carries only the
// redacted transcript — no extra wrapper — so what governs the output lives in the
// user-editable prompt.

/**
 * Redact the transcript and shape it as a {@link BuiltContext} so the same
 * AiConsentDialog ("send N lines to <endpoint>") can preview exactly what will be
 * sent. `text` is the redacted transcript — i.e. what actually leaves the machine.
 */
export function buildRunbookContext(transcript: string): BuiltContext {
  const clean = transcript.replace(/\s+$/u, "");
  const r = redactSecrets(clean);
  return {
    text: r.text,
    lines: r.text ? r.text.split("\n").length : 0,
    redactions: r.count,
    sources: ["recording"],
  };
}
