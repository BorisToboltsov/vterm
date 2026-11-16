// Formatting a buffer (ADR 0076). The project's own tool, where the file
// lives — on the server over SSH, on this computer for a local tab — reading the
// buffer on stdin and printing the result, run in the file's folder so the
// project's config applies (pyproject, rustfmt.toml, .prettierrc, .yamlfmt).
// Two formatters are built in and always there: JSON and «whitespace only».
// The argv is built here; the backend checks it against its policy
// (`format::check_args`) before anything runs.

import type { EditorLangKind } from "./editorlang";
import { indentString, reindent, type IndentInfo } from "./indent";
import type { FormatRun } from "../types";

export interface FormatTarget {
  /** Basename — for tools that pick their parser and config by name. */
  name: string;
  /** Absolute path — for prettier's `--stdin-filepath`. */
  path: string;
  indent: IndentInfo;
  /** `insert_final_newline` of `.editorconfig`; unset — yes. */
  finalNewline?: boolean;
  /** Rust edition from the crate, when the project map read it. */
  edition?: string;
}

export interface Formatter {
  id: string;
  /** The tool as the menu names it (untranslated: a program's name). */
  label: string;
  /** Built in: no program, runs in the window. */
  builtin?: boolean;
  /** The program the server or this computer runs; absent for a built-in. */
  program?: string;
  args?: (t: FormatTarget) => string[];
  /** Changes more than layout (`ansible-lint --fix`): never a default, never on save. */
  fixer?: boolean;
}

const EDITIONS = new Set(["2015", "2018", "2021", "2024"]);

export const FORMATTERS: readonly Formatter[] = [
  { id: "ruff", label: "ruff format", program: "ruff", args: (t) => ["format", "--stdin-filename", t.name, "-"] },
  { id: "black", label: "black", program: "black", args: (t) => ["-q", "--stdin-filename", t.name, "-"] },
  { id: "terraform", label: "terraform fmt", program: "terraform", args: () => ["fmt", "-"] },
  { id: "tofu", label: "tofu fmt", program: "tofu", args: () => ["fmt", "-"] },
  {
    id: "rustfmt",
    label: "rustfmt",
    program: "rustfmt",
    args: (t) => ["--emit", "stdout", "--edition", t.edition && EDITIONS.has(t.edition) ? t.edition : "2021"],
  },
  { id: "gofmt", label: "gofmt", program: "gofmt", args: () => [] },
  { id: "shfmt", label: "shfmt", program: "shfmt", args: (t) => ["-filename", t.name] },
  { id: "yamlfmt", label: "yamlfmt", program: "yamlfmt", args: () => ["-in"] },
  { id: "prettier", label: "prettier", program: "prettier", args: (t) => ["--stdin-filepath", t.path] },
  { id: "xmllint", label: "xmllint --format", program: "xmllint", args: () => ["--format", "-"] },
  { id: "clang-format", label: "clang-format", program: "clang-format", args: (t) => [`--assume-filename=${t.name}`] },
  { id: "json", label: "JSON", builtin: true },
  { id: "whitespace", label: "whitespace", builtin: true },
  { id: "ansible-lint", label: "ansible-lint --fix", program: "ansible-lint", args: () => ["--fix"], fixer: true },
];

const YAML: readonly string[] = ["yamlfmt", "prettier"];
const WEB: readonly string[] = ["prettier"];

/** The tools for a language, first found wins; «whitespace» closes every list. */
const CHAINS: Partial<Record<EditorLangKind, readonly string[]>> = {
  python: ["ruff", "black"],
  hcl: ["terraform", "tofu"],
  rust: ["rustfmt"],
  go: ["gofmt"],
  shell: ["shfmt"],
  yaml: YAML,
  compose: YAML,
  ghactions: YAML,
  prometheus: YAML,
  k8s: YAML,
  ansible: YAML,
  json: ["json", "prettier"],
  javascript: WEB,
  typescript: WEB,
  css: WEB,
  scss: WEB,
  less: WEB,
  html: WEB,
  markdown: WEB,
  xml: ["xmllint"],
  c: ["clang-format"],
  cpp: ["clang-format"],
};

export function formatterById(id: string): Formatter | undefined {
  return FORMATTERS.find((f) => f.id === id);
}

/** The formatters the menu offers for `kind`, in the order they are tried. */
export function formattersFor(kind: EditorLangKind): Formatter[] {
  const ids = [...(CHAINS[kind] ?? []), "whitespace"];
  return ids.map((id) => formatterById(id)).filter((f): f is Formatter => !!f);
}

/** The fixer the menu offers beside formatting, for `kind` (Ansible: `ansible-lint --fix`). */
export function fixerFor(kind: EditorLangKind): Formatter | null {
  return kind === "ansible" ? (formatterById("ansible-lint") ?? null) : null;
}

/**
 * The formatter to run: the one picked for the language, when it is still on
 * its list; otherwise the list in order (the caller moves on when a program is
 * not installed).
 */
export function formatOrder(kind: EditorLangKind, picked: string | undefined): Formatter[] {
  const list = formattersFor(kind);
  const chosen = picked ? list.find((f) => f.id === picked) : undefined;
  return chosen ? [chosen, ...list.filter((f) => f !== chosen)] : list;
}

/** The argv a formatter runs with on `target`; null for a built-in. */
export function formatArgv(f: Formatter, target: FormatTarget): string[] | null {
  if (f.builtin || !f.program || !f.args) return null;
  return [f.program, ...f.args(target)];
}

/** Trailing spaces off, the indentation to the file's unit, one final newline. */
export function formatWhitespace(text: string, t: Pick<FormatTarget, "indent" | "finalNewline">): string {
  let out = reindent(
    text
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n"),
    t.indent,
    t.indent,
  );
  if (t.finalNewline !== false) out = out.replace(/\n*$/, "") + (out.trim() === "" ? "" : "\n");
  return out;
}

/** A JSON token: punctuation, a literal, a number or a string — kept verbatim. */
type Tok = { k: "p"; v: string } | { k: "v"; v: string };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if ("{}[]:,".includes(c)) {
      out.push({ k: "p", v: c });
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        if (text[j] === "\n") throw new Error("line break in a string");
        j++;
      }
      if (j >= text.length) throw new Error("unterminated string");
      out.push({ k: "v", v: text.slice(i, j + 1) });
      i = j + 1;
    } else {
      const m = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
      if (!m) throw new Error(`unexpected '${c}'`);
      out.push({ k: "v", v: m[1] });
      i += m[1].length;
    }
  }
  return out;
}

/**
 * JSON laid out with the file's indentation — numbers, strings and key order
 * exactly as written (a `JSON.parse` round trip reorders integer keys and
 * rounds big numbers). Throws on text that is not JSON.
 */
export function formatJson(text: string, t: Pick<FormatTarget, "indent" | "finalNewline">): string {
  const toks = tokenize(text);
  if (toks.length === 0) return text;
  const unit = indentString(t.indent);
  let out = "";
  let depth = 0;
  let i = 0;
  const value = (): void => {
    const tok = toks[i];
    if (!tok) throw new Error("unexpected end");
    if (tok.k === "v") {
      out += tok.v;
      i++;
      return;
    }
    if (tok.v !== "{" && tok.v !== "[") throw new Error(`unexpected '${tok.v}'`);
    const close = tok.v === "{" ? "}" : "]";
    const obj = tok.v === "{";
    i++;
    if (toks[i]?.k === "p" && toks[i].v === close) {
      out += tok.v + close;
      i++;
      return;
    }
    out += tok.v;
    depth++;
    for (;;) {
      out += "\n" + unit.repeat(depth);
      if (obj) {
        const key = toks[i];
        if (!key || key.k !== "v" || !key.v.startsWith('"')) throw new Error("expected a key");
        out += key.v;
        i++;
        if (toks[i]?.v !== ":") throw new Error("expected ':'");
        out += ": ";
        i++;
      }
      value();
      const sep = toks[i];
      if (sep?.v === ",") {
        out += ",";
        i++;
        continue;
      }
      if (sep?.v === close) {
        i++;
        break;
      }
      throw new Error(`expected ',' or '${close}'`);
    }
    depth--;
    out += "\n" + unit.repeat(depth) + close;
  };
  value();
  if (i !== toks.length) throw new Error("text after the value");
  return t.finalNewline === false ? out : out + "\n";
}

/** A built-in formatter's result. */
export function runBuiltin(id: string, text: string, t: FormatTarget): string {
  if (id === "json") return formatJson(text, t);
  return formatWhitespace(text, t);
}

/** How many lines differ between two texts (the status message: «changed N lines»). */
export function changedLines(a: string, b: string): number {
  if (a === b) return 0;
  const x = a.split("\n");
  const y = b.split("\n");
  // Trim the shared head and tail; what is left is compared by a small LCS.
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xs = x.slice(s, x.length - e);
  const ys = y.slice(s, y.length - e);
  if (xs.length * ys.length > 4_000_000) return Math.max(xs.length, ys.length);
  let prev = new Array<number>(ys.length + 1).fill(0);
  for (const xi of xs) {
    const cur = new Array<number>(ys.length + 1).fill(0);
    for (let j = 0; j < ys.length; j++) cur[j + 1] = xi === ys[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]);
    prev = cur;
  }
  return Math.max(xs.length, ys.length) - prev[ys.length];
}

/**
 * The one change that turns `cur` into `next`: the shared head and tail kept,
 * the middle replaced — one undo takes it back, and the cursor outside it stays.
 */
export function minimalChange(cur: string, next: string): { from: number; to: number; insert: string } | null {
  if (cur === next) return null;
  let from = 0;
  while (from < cur.length && from < next.length && cur[from] === next[from]) from++;
  let tail = 0;
  while (tail < cur.length - from && tail < next.length - from && cur[cur.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return { from, to: cur.length - tail, insert: next.slice(from, next.length - tail) };
}

/** The text a tool's run gives, or why it gives none (its first lines of stderr). */
export function formatResult(f: Formatter, run: FormatRun): { text: string } | { error: string } {
  if (f.fixer) return run.stdout === "" ? { error: firstLines(run.stderr) } : { text: run.stdout };
  if (run.code !== 0 || (run.stdout === "" && run.stderr.trim() !== "")) {
    return { error: firstLines(run.stderr || run.stdout) || `exit ${run.code}` };
  }
  return { text: run.stdout };
}

function firstLines(s: string): string {
  return s.trim().split("\n").slice(0, 6).join("\n").slice(0, 800);
}
