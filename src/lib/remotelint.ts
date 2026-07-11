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
  // Daemon config validators (Phase A).
  "sshdconfig",
  "sudoers",
  "haproxy",
  "bind",
  "systemd",
  // YAML-family dialects (Phase B).
  "compose",
  "ghactions",
  "prometheus",
  "ansible",
  "k8s",
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

/**
 * `sshd -t -f FILE` output: `FILE: line 42: Bad configuration option: foo` (or the
 * older `FILE line 42:` form), plus summary lines like `terminating, 1 bad …`. A
 * clean config prints nothing, so an empty result means OK.
 */
function parseSshd(output: string): LintMsg[] {
  const out: LintMsg[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/FILE:?\s*line\s+(\d+)[:\s]+(.*)/i);
    if (m) {
      const message = m[2].trim();
      out.push({ line: Number(m[1]), level: "error", message: message || line });
    } else if (/\b(bad|error|unsupported|unknown|missing|invalid)\b/i.test(line)) {
      // Summary/other diagnostics without a line number (e.g. "terminating, 1 bad …").
      out.push({ line: 1, level: "error", message: line.replace(/^FILE:?\s*/i, "") });
    }
  }
  return out;
}

/**
 * `visudo -c -f FILE` output: `>>> FILE: syntax error near line 5 <<<`. Success is
 * `FILE: parsed OK` — reported as clean (no messages).
 */
function parseVisudo(output: string): LintMsg[] {
  const out: LintMsg[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/>>>|<<</g, "").trim();
    if (!line || /parsed OK/i.test(line)) continue;
    const m = line.match(/near line (\d+)/i);
    const message = line.replace(/^FILE:?\s*/i, "").trim();
    out.push({ line: m ? Number(m[1]) : 1, level: "error", message: message || line });
  }
  return out;
}

/**
 * `haproxy -c -f FILE` output: `[ALERT] (pid) : parsing [FILE:12] : <message>`, with
 * `[WARNING]`/`[NOTICE]` for lesser issues. `Configuration file is valid` and lines
 * with no severity tag are ignored, so a valid config yields no messages.
 */
function parseHaproxy(output: string): LintMsg[] {
  const out: LintMsg[] = [];
  for (const raw of output.split("\n")) {
    const tag = raw.match(/\[(ALERT|EMERG|WARNING|NOTICE)\]/i);
    if (!tag) continue;
    const lm = raw.match(/\[FILE:(\d+)\]/);
    const kind = tag[1].toUpperCase();
    const level: LintLevel = kind === "WARNING" ? "warning" : kind === "NOTICE" ? "info" : "error";
    const message = raw
      .replace(/^\s*\[[A-Z]+\]\s*(\(\d+\))?\s*:?\s*/i, "")
      .replace(/\[FILE:\d+\]/, "FILE")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ line: lm ? Number(lm[1]) : 1, level, message: message || raw.trim() });
  }
  return out;
}

/**
 * `systemd-analyze verify FILE` output: keyed diagnostics `FILE:5: Unknown key …`
 * plus unkeyed problems (`… is not executable`, `Failed to …`). Parse the keyed ones
 * precisely and keep unkeyed error-ish lines at line 1 so a broken unit is never
 * reported as clean.
 */
function parseSystemd(output: string): LintMsg[] {
  const out: LintMsg[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/FILE:(\d+)(?::(\d+))?:?\s*(.*)/);
    if (m && m[3].trim()) {
      out.push({
        line: Number(m[1]),
        col: m[2] ? Number(m[2]) : undefined,
        level: levelOf(m[3]),
        message: m[3].trim(),
      });
    } else if (/\b(fail|failed|invalid|unknown|not (executable|found|exist)|does not exist|bad)\b/i.test(line)) {
      out.push({ line: 1, level: "error", message: line.replace(/^FILE:?\s*/i, "") });
    }
  }
  return out;
}

/**
 * Best-effort parser for tools without a stable `FILE:line:col` format (Phase B:
 * `docker compose config`, `promtool`, `kubeconform`). Keep only lines that look like
 * a problem (so a valid config — `SUCCESS`/`is valid`/empty — yields no messages) and
 * pull an embedded line number when one is present, else pin to line 1.
 */
function parseGeneric(output: string): LintMsg[] {
  const problem =
    /\b(errors?|invalid|failed|failure|fatal|cannot|can't|must|expected|unexpected|unknown|undefined|missing|not|deprecat\w*)\b|no such/i;
  const out: LintMsg[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || !problem.test(line)) continue;
    const m = line.match(/(?:\bline\s+|:)(\d+)\b/i);
    // Lines are pre-filtered to problems, so treat as error unless clearly a warning.
    const level: LintLevel = /\b(warn|warning|deprecat)/i.test(line) ? "warning" : "error";
    out.push({ line: m ? Number(m[1]) : 1, level, message: line });
  }
  return out;
}

/** Parse a lint result's output for its tool format into diagnostics. */
export function parseLint(output: string, format: string): LintMsg[] {
  switch (format) {
    case "nginx":
      return parseNginx(output);
    case "sshd":
      return parseSshd(output);
    case "visudo":
      return parseVisudo(output);
    case "haproxy":
      return parseHaproxy(output);
    case "systemd":
      return parseSystemd(output);
    case "generic":
      return parseGeneric(output);
    default:
      return parseColon(output);
  }
}
