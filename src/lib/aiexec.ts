// Pure helpers for the AI executor (Phase 17.4, opt-in assistant).
//
// The assistant streams Markdown; runnable shell commands arrive in fenced
// ```bash / ```sh blocks (see AiChat's system prompt). To attach an "Execute"
// button per command without losing the fence language (renderMarkdown drops
// it), we split a reply into ordered text / code segments here and let AiChat
// render code segments itself. Executing a block writes it to the terminal and
// annotates the active recording (audit) — those effects are impure and live in
// the component; this module is DOM/network-free and unit-tested directly.

/** One ordered piece of an assistant reply. */
import { submitBlock } from "./terminput";

export interface ChatSegment {
  kind: "text" | "code";
  /** Markdown (text) or the raw command block (code). */
  content: string;
  /** Fence language, lower-cased; "" when the fence had none. */
  lang: string;
  /** A code block in a shell language — eligible for an Execute button. */
  runnable: boolean;
  /** Whether the fence was closed (false while still streaming). */
  closed: boolean;
}

// Fence languages we treat as runnable shell. A bare ``` block is intentionally
// NOT runnable — it is usually example output, and executing arbitrary fenced
// text is unsafe. The system prompt asks the model for ```bash blocks.
const RUNNABLE_LANGS = new Set(["sh", "bash", "shell", "zsh", "console", "shell-session"]);

/** Is `lang` a shell language whose blocks may be executed? */
export function isRunnableLang(lang: string): boolean {
  return RUNNABLE_LANGS.has(lang.trim().toLowerCase());
}

/** Split an assistant Markdown reply into ordered text / code segments. */
export function parseChatSegments(md: string): ChatSegment[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const segments: ChatSegment[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    const content = textBuf.join("\n");
    if (content.trim()) {
      segments.push({ kind: "text", content, lang: "", runnable: false, closed: true });
    }
    textBuf = [];
  };

  let i = 0;
  while (i < lines.length) {
    const fence = /^```(.*)$/.exec(lines[i]);
    if (fence) {
      flushText();
      const lang = fence[1].trim().toLowerCase();
      i++;
      const body: string[] = [];
      let closed = false;
      while (i < lines.length) {
        if (/^```/.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      segments.push({
        kind: "code",
        content: body.join("\n"),
        lang,
        runnable: isRunnableLang(lang),
        closed,
      });
      continue;
    }
    textBuf.push(lines[i]);
    i++;
  }
  flushText();
  return segments;
}

/** A server is "prod" when tagged prod/production — auto-execution is barred there. */
export function isProdServer(tags: readonly string[] | null | undefined): boolean {
  if (!tags) return false;
  return tags.some((tag) => /^prod(uction)?$/i.test(tag.trim()));
}

/**
 * Normalise a command block for the PTY. Every line ending becomes the Enter byte
 * (CR) so each line is submitted in turn — with LF a multi-line block would run
 * only its last line on Windows. See terminput.ts.
 */
export function toTerminalInput(block: string): string {
  return submitBlock(block);
}

/** A compact one-line label for the recording audit trail. */
export function auditLabel(block: string): string {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return lines.length === 1 ? lines[0] : `${lines[0]} … (+${lines.length - 1})`;
}
