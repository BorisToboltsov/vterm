// What a file is made of (ADR 0076): its symbols for `⌘⇧O` and the path to the
// cursor for the breadcrumbs. Read from the text by the shape each language
// writes in — a play and its tasks, a resource, a function, a heading, a
// `server {}` — not by a grammar: the editor's StreamLanguage modes have no
// tree, and the same reading must work for all of them. A language server, when
// one runs, knows more; this is what is known without one.

import type { EditorLangKind } from "./editorlang";

export type SymKind =
  | "play"
  | "task"
  | "key"
  | "document"
  | "service"
  | "job"
  | "resource"
  | "function"
  | "class"
  | "type"
  | "heading"
  | "block"
  | "stage"
  | "section"
  | "target";

export interface OutlineSym {
  name: string;
  kind: SymKind;
  /** 1-based. */
  line: number;
  /** Nesting, from 0. */
  depth: number;
}

/** A segment of the breadcrumbs: what encloses the cursor, outermost first. */
export interface Crumb {
  name: string;
  line: number;
}

const YAML_KINDS: ReadonlySet<EditorLangKind> = new Set(["yaml", "compose", "ghactions", "prometheus", "ansible", "k8s"]);

/** Whether `kind` is YAML underneath (its breadcrumbs are the key path). */
export function isYamlKind(kind: EditorLangKind): boolean {
  return YAML_KINDS.has(kind);
}

const lead = (l: string) => l.length - l.trimStart().length;
const blank = (l: string) => l.trim() === "" || /^\s*#/.test(l);
const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2").replace(/\s+#.*$/, "");

/** Depth from distinct indents, nearest first: indents 0, 4, 8 → 0, 1, 2. */
function withDepths(raw: { name: string; kind: SymKind; line: number; indent: number }[]): OutlineSym[] {
  const levels = [...new Set(raw.map((r) => r.indent))].sort((a, b) => a - b);
  return raw.map((r) => ({ name: r.name, kind: r.kind, line: r.line, depth: levels.indexOf(r.indent) }));
}

function yamlOutline(kind: EditorLangKind, lines: string[]): OutlineSym[] {
  const raw: { name: string; kind: SymKind; line: number; indent: number }[] = [];
  let docStart = 0;
  let section: string | null = null;
  let docKind: string | null = null;
  let inMeta = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^---/.test(l)) {
      docStart = i + 1;
      docKind = null;
      section = null;
      continue;
    }
    if (blank(l)) continue;
    const ind = lead(l);
    if (ind === 0) {
      const top = /^([\w.-]+):/.exec(l);
      section = top ? top[1] : null;
      inMeta = section === "metadata";
    }
    if (kind === "k8s") {
      const k = /^kind:\s*(\S+)/.exec(l);
      if (k) docKind = unquote(k[1]);
      const n = inMeta && ind > 0 ? /^\s+name:\s*(\S.*)$/.exec(l) : null;
      if (n && docKind) {
        raw.push({ name: `${docKind}/${unquote(n[1])}`, kind: "document", line: docStart + 1, indent: 0 });
        inMeta = false;
      }
      continue;
    }
    if (kind === "ansible") {
      const named = /^(\s*)- name:\s*(.+)$/.exec(l);
      if (named) {
        raw.push({ name: unquote(named[2]), kind: ind === 0 ? "play" : "task", line: i + 1, indent: ind });
        continue;
      }
      const hosts = /^- (hosts|import_playbook):\s*(.+)$/.exec(l);
      if (hosts) raw.push({ name: unquote(hosts[2]), kind: "play", line: i + 1, indent: 0 });
      continue;
    }
    if (kind === "compose" || kind === "ghactions") {
      if (ind === 0) {
        const top = /^([\w.-]+):/.exec(l);
        if (top) raw.push({ name: top[1], kind: "key", line: i + 1, indent: 0 });
        continue;
      }
      const child = ind === 2 ? /^\s{2}([\w.-]+):/.exec(l) : null;
      if (kind === "compose" && section === "services" && child) {
        raw.push({ name: child[1], kind: "service", line: i + 1, indent: 1 });
      } else if (kind === "ghactions" && section === "jobs") {
        const step = /^(\s*)- name:\s*(.+)$/.exec(l);
        if (child) raw.push({ name: child[1], kind: "job", line: i + 1, indent: 1 });
        else if (step) raw.push({ name: unquote(step[2]), kind: "task", line: i + 1, indent: 2 });
      }
      continue;
    }
    // Plain YAML (and the rest of a dialect): the top two levels of keys.
    const key = /^(\s*)([\w.$/-]+):(\s|$)/.exec(l);
    if (key && ind <= 2) raw.push({ name: key[2], kind: "key", line: i + 1, indent: ind });
  }
  return withDepths(raw);
}

/** Per-line patterns of the languages read by shape; group 1 — the indent, the rest name it. */
const PATTERNS: Partial<Record<EditorLangKind, { re: RegExp; kind: SymKind; name: (m: RegExpExecArray) => string }[]>> = {
  hcl: [
    { re: /^(\s*)(resource|data)\s+"([^"]+)"\s+"([^"]+)"/, kind: "resource", name: (m) => `${m[2] === "data" ? "data." : ""}${m[3]}.${m[4]}` },
    { re: /^(\s*)(module|variable|output|provider)\s+"([^"]+)"/, kind: "resource", name: (m) => `${m[2]} ${m[3]}` },
    { re: /^(\s*)(locals|terraform)\s*\{/, kind: "block", name: (m) => m[2] },
  ],
  python: [
    { re: /^(\s*)(?:async\s+)?def\s+(\w+)/, kind: "function", name: (m) => m[2] },
    { re: /^(\s*)class\s+(\w+)/, kind: "class", name: (m) => m[2] },
  ],
  rust: [
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, kind: "function", name: (m) => m[2] },
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod|union)\s+(\w+)/, kind: "type", name: (m) => `${m[2]} ${m[3]}` },
    { re: /^(\s*)impl(?:<[^>]*>)?\s+([^{]+?)\s*\{/, kind: "class", name: (m) => `impl ${m[2].trim()}` },
    { re: /^(\s*)macro_rules!\s*(\w+)/, kind: "function", name: (m) => `${m[2]}!` },
  ],
  go: [
    { re: /^()func\s+(?:\(\s*\w*\s*\*?(\w+)[^)]*\)\s*)?(\w+)/, kind: "function", name: (m) => (m[2] ? `${m[2]}.${m[3]}` : m[3]) },
    { re: /^()type\s+(\w+)\s+(struct|interface)/, kind: "type", name: (m) => m[2] },
  ],
  javascript: [
    { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)/, kind: "function", name: (m) => m[2] },
    { re: /^(\s*)(?:export\s+)?(?:default\s+)?class\s+(\w+)/, kind: "class", name: (m) => m[2] },
    { re: /^(\s*)(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/, kind: "function", name: (m) => m[2] },
  ],
  shell: [
    { re: /^(\s*)function\s+([\w.:-]+)/, kind: "function", name: (m) => m[2] },
    { re: /^(\s*)([\w.:-]+)\s*\(\)\s*\{?/, kind: "function", name: (m) => m[2] },
  ],
  nginx: [
    { re: /^(\s*)(http|events|stream|mail|server|types)\s*\{/, kind: "block", name: (m) => m[2] },
    { re: /^(\s*)((?:location|upstream|map|geo|if|limit_except)\s+[^{]*?)\s*\{/, kind: "block", name: (m) => m[2].replace(/\s+/g, " ") },
  ],
  dockerfile: [{ re: /^()FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i, kind: "stage", name: (m) => (m[3] ? `${m[3]} (${m[2]})` : m[2]) }],
  groovy: [
    { re: /^(\s*)stage\s*\(\s*['"]([^'"]+)['"]/, kind: "stage", name: (m) => m[2] },
    { re: /^(\s*)def\s+(\w+)\s*\(/, kind: "function", name: (m) => m[2] },
  ],
  java: [{ re: /^(\s*)(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+(\w+)/, kind: "class", name: (m) => m[3] }],
  csharp: [{ re: /^(\s*)(?:public\s+|private\s+|internal\s+|protected\s+)?(?:abstract\s+|sealed\s+|static\s+|partial\s+)*(class|interface|enum|record|struct)\s+(\w+)/, kind: "class", name: (m) => m[3] }],
  ruby: [
    { re: /^(\s*)def\s+([\w.?!]+)/, kind: "function", name: (m) => m[2] },
    { re: /^(\s*)(?:class|module)\s+([\w:]+)/, kind: "class", name: (m) => m[2] },
  ],
  lua: [{ re: /^(\s*)(?:local\s+)?function\s+([\w.:]+)/, kind: "function", name: (m) => m[2] }],
  perl: [{ re: /^(\s*)sub\s+(\w+)/, kind: "function", name: (m) => m[2] }],
  powershell: [{ re: /^(\s*)function\s+([\w-]+)/i, kind: "function", name: (m) => m[2] }],
};
PATTERNS.typescript = [
  ...(PATTERNS.javascript ?? []),
  { re: /^(\s*)(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+(\w+)/, kind: "type", name: (m) => m[3] },
];

const SECTION_KINDS: ReadonlySet<EditorLangKind> = new Set(["ini", "systemd", "toml"]);

function markdownOutline(lines: string[]): OutlineSym[] {
  const out: OutlineSym[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) {
      fence = fence === null ? f[1] : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) out.push({ name: h[2], kind: "heading", line: i + 1, depth: h[1].length - 1 });
  }
  return out;
}

/** Make targets, for a Makefile (its kind is plain text — no grammar for it). */
export function makeTargets(text: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_][\w.\-/]*)\s*:(?!=|:=)/.exec(lines[i]);
    if (!m || m[1].startsWith(".") || m[1].includes("%")) continue;
    out.push({ name: m[1], line: i + 1 });
  }
  return out;
}

/** The symbols of a file, in order. `name` is the file's basename (a Makefile is plain text). */
export function outline(kind: EditorLangKind, text: string, name = ""): OutlineSym[] {
  const lines = text.split("\n");
  if (isYamlKind(kind)) return yamlOutline(kind, lines);
  if (kind === "markdown") return markdownOutline(lines);
  if (SECTION_KINDS.has(kind)) {
    const out: OutlineSym[] = [];
    lines.forEach((l, i) => {
      const m = /^\s*\[\[?([^\]]+)\]\]?/.exec(l);
      if (m) out.push({ name: m[1].trim(), kind: "section", line: i + 1, depth: 0 });
    });
    return out;
  }
  if (kind === "plain" && /^(gnu)?makefile$|\.mk$/i.test(name)) {
    return makeTargets(text).map((t) => ({ name: t.name, kind: "target" as const, line: t.line, depth: 0 }));
  }
  const pats = PATTERNS[kind];
  if (!pats) return [];
  const raw: { name: string; kind: SymKind; line: number; indent: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of pats) {
      const m = p.re.exec(lines[i]);
      if (!m) continue;
      raw.push({ name: p.name(m), kind: p.kind, line: i + 1, indent: m[1].length });
      break;
    }
  }
  return withDepths(raw);
}

/** The last line (1-based) of the block a line opens, by indentation. */
export function blockEnd(lines: readonly string[], line: number): number {
  const first = lines[line - 1] ?? "";
  const base = lead(first);
  let end = line;
  for (let i = line; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const ind = lead(l);
    if (ind > base) {
      end = i + 1;
      continue;
    }
    // A closing bracket at the opener's indent still belongs to it.
    if (ind === base && /^\s*[}\])]/.test(l)) end = i + 1;
    break;
  }
  return end;
}

function yamlCrumbs(lines: string[], line: number): Crumb[] {
  const out: Crumb[] = [];
  let i = Math.min(line, lines.length) - 1;
  while (i >= 0 && blank(lines[i])) i--;
  if (i < 0) return [];
  let limit = Infinity;
  for (; i >= 0; i--) {
    const l = lines[i];
    if (/^---/.test(l)) break;
    if (blank(l)) continue;
    const ind = lead(l);
    if (ind >= limit) continue;
    const item = /^\s*-\s+(?:name:\s*(.+)|([\w.$/-]+):)/.exec(l);
    const key = /^\s*([\w.$/-]+):(\s|$)/.exec(l);
    if (item) out.push({ name: item[1] ? unquote(item[1]) : item[2], line: i + 1 });
    else if (key) out.push({ name: key[1], line: i + 1 });
    else if (/^\s*-/.test(l)) out.push({ name: "-", line: i + 1 });
    else continue;
    limit = ind;
    if (ind === 0) break;
  }
  return out.reverse();
}

/** What encloses the cursor's 1-based `line`, outermost first. */
export function breadcrumbs(kind: EditorLangKind, text: string, line: number, name = ""): Crumb[] {
  const lines = text.split("\n");
  if (isYamlKind(kind)) return yamlCrumbs(lines, line);
  const syms = outline(kind, text, name);
  if (kind === "markdown") {
    const chain: OutlineSym[] = [];
    for (const s of syms) {
      if (s.line > line) break;
      while (chain.length > 0 && chain[chain.length - 1].depth >= s.depth) chain.pop();
      chain.push(s);
    }
    return chain.map((s) => ({ name: s.name, line: s.line }));
  }
  const out: Crumb[] = [];
  for (const s of syms) {
    if (s.line > line) break;
    if (blockEnd(lines, s.line) >= line) {
      while (out.length > 0 && out.length > s.depth) out.pop();
      out.push({ name: s.name, line: s.line });
    }
  }
  return out;
}
