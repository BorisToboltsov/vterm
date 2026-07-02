// Pure logic for the AI dialog / agent loop (Phase 17.8, opt-in assistant).
//
// In the dialog modes the assistant proposes ONE command, we run it (ai_exec),
// then feed the captured result back as the next message so it can decide the
// next step. Everything here is DOM/network-free and unit-tested; the loop that
// drives it (execute, confirm, stop, step cap) lives in stores/aichat, and the
// actual execution + terminal/recording mirror is in the Rust `ai_exec` command.

import { parseChatSegments } from "./aiexec";
import { redactSecrets } from "./redact";
import type { AiExecResult } from "./api";

/** Appended to the chat system prompt in dialog modes so the model runs one step
 *  at a time and waits for each command's output. */
export const DIALOG_SYSTEM_SUFFIX =
  "\n\nYou are in interactive execution mode. Propose ONE shell command at a time in a single " +
  "fenced ```bash block, then stop — you will receive that command's output (stdout, stderr and " +
  "exit code) as the next message, and use it to decide the next step. When the task is complete " +
  "or no command is needed, reply with a short summary and NO command block.";

/** Cap on how many lines of command output are fed back to the model. */
export const FEEDBACK_MAX_LINES = 200;

/** The next command to run from an assistant reply, or null when there is none
 *  (→ the loop ends). The first runnable, closed shell block wins. */
export function nextCommand(reply: string): string | null {
  const seg = parseChatSegments(reply).find((s) => s.kind === "code" && s.runnable && s.closed);
  const cmd = seg?.content.trim();
  return cmd ? cmd : null;
}

/** Keep only the last `max` lines, noting how many were hidden. */
function tailLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `… (${lines.length - max} earlier lines hidden)\n${lines.slice(-max).join("\n")}`;
}

/**
 * The message fed back to the model after a command runs: the exit status plus the
 * combined output — **redacted** (secrets never go to the LLM) and clipped to the
 * last {@link FEEDBACK_MAX_LINES} lines.
 */
export function buildFeedback(command: string, result: AiExecResult): string {
  const status = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
  const combined = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");
  const clipped = tailLines(combined, FEEDBACK_MAX_LINES);
  const body = redactSecrets(clipped).text.trim();
  return `Output of \`${command}\` (${status}):\n\n\`\`\`\n${body || "(no output)"}\n\`\`\``;
}

// Obvious footguns — flagged so the loop forces confirmation even in auto dialog.
// Best-effort, biased toward over-flagging (a false positive just forces a confirm):
// this is NOT the security boundary — prod/noAi gating + consent + redaction are.
// Phase 20.1 widened it against flag-form and obfuscation bypasses (long/split rm
// flags, --no-preserve-root, find -delete/-exec rm, pipe-to-shell, base64/eval,
// recursive chmod/chown on the filesystem root).
const DANGEROUS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, // rm -rf / rm -fr (combined flags)
  /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\*)/i, // rm -r on / ~ *
  /\brm\s+-[a-z]*r[a-z]*\s+-[a-z]*f|\brm\s+-[a-z]*f[a-z]*\s+-[a-z]*r/i, // rm -r … -f (split flags)
  /\brm\b[^\n]*--recursive\b/i, // rm --recursive … (long-form)
  /\brm\b[^\n]*--no-preserve-root\b/i, // rm … --no-preserve-root
  /\bfind\b[^\n]*\s-delete\b/i, // find … -delete
  /\bfind\b[^\n]*-exec\s+rm\b/i, // find … -exec rm
  /\bmkfs\b/i,
  /\bdd\b\s+.*\bof=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{.*\};?\s*:/, // fork bomb :(){ :|:& };:
  /\bchmod\s+-R\s+0*777\b/i, // world-writable recursive
  /\bch(mod|own)\s+-R\b[^\n|;&]*\s\/(\s|$)/i, // recursive chmod/chown on the filesystem root
  /(^|[^>])>>?\s*\/(etc|dev|sys|boot|usr|bin|sbin|proc)\b/i, // redirect into system paths
  /\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh)\b/i, // piping opaque content into a shell (curl|sh)
  /\bbase64\b[^\n]*(?:\s-[a-z]*d\b|--decode)/i, // base64 decode — obfuscated payloads
  /\beval\b/i, // eval — arbitrary/obfuscated execution
];

/** Whether a command looks destructive → require confirmation even in auto mode. */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}
