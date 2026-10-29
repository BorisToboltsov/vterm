// Pure helpers for turning a recording into an executable artifact — a shell
// script or an Ansible playbook (Phase 17.6, opt-in assistant). The AI is asked
// to reply with a single fenced code block; here we pull the script text back
// out of that reply and derive a filename so it can open in the CodeMirror editor
// (with syntax highlighting + the server-side linter). DOM/network-free, so it is
// unit-tested directly; the streaming + editor wiring stay in the components.

import { parseChatSegments } from "./aiexec";

/** Which artifact to generate from a recording. */
export type ScriptKind = "sh" | "ansible";

// Fence languages that count as "the script" for each kind.
const LANGS: Record<ScriptKind, Set<string>> = {
  sh: new Set(["bash", "sh", "shell", "zsh", "console"]),
  ansible: new Set(["yaml", "yml", "ansible"]),
};

/** Editor filename extension per kind (drives the language + linter). */
export function scriptExt(kind: ScriptKind): string {
  return kind === "ansible" ? "yml" : "sh";
}

/**
 * Extract the script body from the model's reply. Prefer the longest fenced
 * block whose language matches the kind; fall back to the longest code block of
 * any language, then to the whole reply (a model that returned bare script text).
 */
export function extractScript(markdown: string, kind: ScriptKind): string {
  const code = parseChatSegments(markdown).filter((s) => s.kind === "code");
  const longest = (list: typeof code) =>
    list.reduce<string | null>((best, s) => (best === null || s.content.length > best.length ? s.content : best), null);

  const matched = longest(code.filter((s) => LANGS[kind].has(s.lang)));
  if (matched !== null) return matched.trim();
  const any = longest(code);
  if (any !== null) return any.trim();
  return markdown.trim();
}

/** Turn a recording title into a safe, lower-kebab filename with the kind's ext. */
export function scriptFileName(title: string, kind: ScriptKind): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "runbook"}.${scriptExt(kind)}`;
}
