// Parse server-side linter output into diagnostics (Phase 12.7). The backend runs
// a real tool (yamllint/shellcheck/hadolint/ruff/nginx -t) on the buffer and returns
// combined stdout+stderr with the temp path replaced by `FILE`; this maps that text
// to {line, col, level, message}. Pure + testable; the editor renders the list.

import type { EditorLangKind } from "./editorlang";

export type LintLevel = "error" | "warning" | "info";

export interface LintMsg {
  line: number;
  col?: number;
  level: LintLevel;
  message: string;
}

/** Result shape from the `lint_remote` command (mirrors sync.rs LintResult). */
export interface RemoteLintResult {
  tool: string;
  found: boolean;
  output: string;
  format: string;
}

/** Language kinds that have a server linter wired (mirrors sync.rs lint_tool). */
const LINTER_KINDS = new Set<EditorLangKind>([
  "yaml",
  "shell",
  "dockerfile",
  "python",
  "nginx",
]);

export function hasRemoteLinter(kind: EditorLangKind): boolean {
  return LINTER_KINDS.has(kind);
}

function levelOf(s: string): LintLevel {
  if (/\b(error|emerg|fatal)\b|\[E\d|:\s*e:/i.test(s)) return "error";
  if (/\b(warn|warning)\b|\[W\d/i.test(s)) return "warning";
  return "info";
}

/** `FILE:line[:col]: message` format (yamllint parsable, shellcheck -f gcc, ruff). */
function parseColon(output: string): LintMsg[] {
  const out: LintMsg[] = [];
  for (const raw of output.split("\n")) {
    const m = raw.match(/FILE:(\d+)(?::(\d+))?:?\s*(.*)/);
    if (!m) continue;
    const message = m[3].trim();
    if (!message) continue;
    out.push({
      line: Number(m[1]),
      col: m[2] ? Number(m[2]) : undefined,
      level: levelOf(message),
      message,
    });
  }
  return out;
}

/** `nginx -t` output: `nginx: [emerg] … in FILE:line`. Success has no `[emerg]`. */
function parseNginx(output: string): LintMsg[] {
  const out: LintMsg[] = [];
  for (const raw of output.split("\n")) {
    if (!/\[(emerg|error|warn|crit)\]/i.test(raw)) continue;
    const m = raw.match(/\bin FILE:(\d+)/);
    out.push({
      line: m ? Number(m[1]) : 1,
      level: levelOf(raw),
      message: raw.replace(/\bin FILE:\d+/, "").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/** Parse a lint result's output for its tool format into diagnostics. */
export function parseLint(output: string, format: string): LintMsg[] {
  return format === "nginx" ? parseNginx(output) : parseColon(output);
}
