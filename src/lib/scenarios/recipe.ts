// A recipe (ADR 0071): an ordinary shell script with a `# vterm:` header — its
// name, what it is for, the systems it knows, whether it needs root, whether it
// can say what it would change, and its parameters. The file stays a script:
// `sh recipe.sh` runs it without vterm (its last line picks `apply` when
// VTERM_MODE is not set). Pure: parsing the header, building the text a server
// runs, reading what the server answered.
//
//   #!/bin/sh
//   # vterm:
//   #   name: Install Docker
//   #   description: Docker Engine and compose
//   #   os: [debian, ubuntu]
//   #   sudo: true
//   #   check: true
//   #   params:
//   #     DOCKER_USER: { label: User in the docker group, default: deploy }
//   check() { …; }      # 0 — already so, 1 — would change (prints what)
//   apply() { …; }
//   case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac

export type ParamType = "text" | "bool" | "secret";

export interface RecipeParam {
  /** The variable the script reads: `[A-Z_][A-Z0-9_]*`. */
  name: string;
  label: string;
  type: ParamType;
  /** The value offered first ("" — none; "true"/"false" for a switch). */
  default: string;
  /** An empty value is refused before the run. */
  required: boolean;
  hint: string;
}

export interface RecipeMeta {
  name: string;
  description: string;
  os: string[];
  sudo: boolean;
  /** The script has a `check` it runs under VTERM_MODE=check. */
  check: boolean;
  params: RecipeParam[];
}

export type RecipeParse = { ok: true; meta: RecipeMeta } | { ok: false; error: string };

/** Variables a parameter may not be: the shell's own and the run's. */
const RESERVED = new Set(["VTERM_MODE", "PATH", "HOME", "IFS", "PS1", "PS2", "PS4", "ENV", "SHELL", "PWD", "OLDPWD", "SUDO_USER", "DEBIAN_FRONTEND"]);
const PARAM_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Split `s` on `sep` outside quotes, brackets and braces. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** A scalar of the header: quotes removed. */
function scalar(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

/** `[a, b]` → ["a", "b"]; a bare word → [word]. */
function list(v: string): string[] {
  const s = v.trim();
  const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
  return splitTop(inner, ",")
    .map(scalar)
    .filter((x) => x !== "");
}

/** `{ a: 1, b: x }` → { a: "1", b: "x" }. */
export function flowMap(v: string): Record<string, string> | null {
  const s = v.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  const out: Record<string, string> = {};
  for (const part of splitTop(s.slice(1, -1), ",")) {
    if (!part.trim()) continue;
    const i = part.indexOf(":");
    if (i < 0) return null;
    out[part.slice(0, i).trim()] = scalar(part.slice(i + 1));
  }
  return out;
}

/**
 * A value as the header writes it — the inverse of `scalar`: bare when it reads
 * back as itself, quoted when it holds what the header splits on (`,`, `:`,
 * brackets, braces, `#`) or a quote, or has spaces at its ends.
 */
export function headerValue(v: string): string {
  const s = v.replace(/[\r\n]+/g, " ");
  if (s !== "" && s === s.trim() && !/[,:{}[\]#"']/.test(s)) return s;
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/"/g, "'")}"`;
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(true|yes|on|1)$/i.test(v.trim());

/** The header's lines, without their `#` and the indent common to them. */
function headerLines(text: string): string[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  // Before the header: the shebang, blank lines and comments.
  while (i < lines.length && !/^#\s*vterm:\s*$/.test(lines[i])) {
    if (lines[i].trim() !== "" && !lines[i].startsWith("#")) return null;
    i++;
  }
  if (i >= lines.length) return null;
  const out: string[] = [];
  for (i++; i < lines.length; i++) {
    const m = /^#(\s{2,}.*)$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1]);
  }
  const indent = Math.min(...out.map((l) => /^\s*/.exec(l)![0].length));
  return out.map((l) => l.slice(indent));
}

/** Read a recipe's header. A script without one is not a recipe. */
export function parseRecipe(text: string): RecipeParse {
  const lines = headerLines(text);
  if (!lines || lines.length === 0) return { ok: false, error: "no # vterm: header" };
  const meta: RecipeMeta = { name: "", description: "", os: [], sudo: false, check: false, params: [] };
  let inParams = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const nested = /^\s+/.test(raw);
    const line = raw.trim();
    const i = line.indexOf(":");
    if (i < 0) return { ok: false, error: `not a key: ${line}` };
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (nested && inParams) {
      if (!PARAM_NAME.test(key) || RESERVED.has(key)) return { ok: false, error: `not a parameter name: ${key}` };
      if (meta.params.some((p) => p.name === key)) return { ok: false, error: `parameter twice: ${key}` };
      const m = value === "" ? {} : flowMap(value);
      if (!m) return { ok: false, error: `parameter ${key}: { label: …, default: … }` };
      const type: ParamType = m.type === "bool" || m.type === "secret" ? m.type : "text";
      meta.params.push({
        name: key,
        label: m.label || key,
        type,
        default: type === "secret" ? "" : type === "bool" ? String(truthy(m.default)) : (m.default ?? ""),
        required: truthy(m.required),
        hint: m.hint ?? "",
      });
      continue;
    }
    inParams = false;
    switch (key) {
      case "name":
        meta.name = scalar(value);
        break;
      case "description":
        meta.description = scalar(value);
        break;
      case "os":
        meta.os = list(value).map((x) => x.toLowerCase());
        break;
      case "sudo":
        meta.sudo = truthy(value);
        break;
      case "check":
        meta.check = truthy(value);
        break;
      case "params":
        inParams = true;
        break;
      default:
        // An unknown key is kept for later versions: not an error.
        break;
    }
  }
  if (!meta.name) return { ok: false, error: "the header has no name" };
  return { ok: true, meta };
}

/** A value in single quotes for a POSIX shell. */
export const shQuote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

export type RecipeMode = "check" | "apply";

/**
 * What the server runs: the parameters exported at the top, the mode, a
 * non-interactive package manager — then the recipe as it is. The text goes
 * on stdin; nothing of it reaches a command line.
 */
export function recipeScript(text: string, meta: RecipeMeta, values: Record<string, string>, mode: RecipeMode): string {
  const lines = [
    "# vterm: the parameters of this run",
    `export VTERM_MODE=${shQuote(mode)}`,
    "export DEBIAN_FRONTEND='noninteractive'",
  ];
  for (const p of meta.params) {
    const v = values[p.name] ?? p.default;
    lines.push(`export ${p.name}=${shQuote(p.type === "bool" ? (v === "true" ? "true" : "false") : v)}`);
  }
  return `${lines.join("\n")}\n${text.replace(/\r\n?/g, "\n")}`;
}

/** Why the values cannot run: the first required parameter left empty, or a line break in a value. */
export function valuesProblem(meta: RecipeMeta, values: Record<string, string>): { param: string; why: "required" | "newline" } | null {
  for (const p of meta.params) {
    const v = values[p.name] ?? p.default;
    if (p.required && v.trim() === "") return { param: p.name, why: "required" };
    if (p.type === "secret" && /[\r\n]/.test(v)) return { param: p.name, why: "newline" };
  }
  return null;
}

/** What a check answered: already so (0), would change (1), or could not tell. */
export type CheckVerdict = "same" | "change" | "error";

export const checkVerdict = (exitCode: number): CheckVerdict => (exitCode === 0 ? "same" : exitCode === 1 ? "change" : "error");

/** The line a server's answer is told by: the last non-empty line of its output, or of its errors. */
export function summaryLine(stdout: string, stderr: string, max = 160): string {
  const pick = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim())
      .filter(Boolean)
      .pop() ?? "";
  const line = pick(stdout) || pick(stderr);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `name` as a file stem: lower case, words joined by `-`; `fallback` when nothing is left. */
function slug(name: string, fallback: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || fallback;
}

/** A file name for a recipe named `name`: lower case, words joined by `-`. */
export const recipeFileName = (name: string): string => `${slug(name, "recipe")}.sh`;

/** A file name for a playbook named `name` (ADR 0072). */
export const playbookFileName = (name: string): string => `${slug(name, "playbook")}.yml`;

/** A name not among `taken`: `x.sh`, `x-2.sh`, … (`x.yml`, `x-2.yml`, …). */
export function freeFileName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const next = `${stem}-${i}${ext}`;
    if (!taken.includes(next)) return next;
  }
}

/** A new recipe to start from: the header, a check, an apply, the last line. */
export function recipeTemplate(name: string, description: string): string {
  return [
    "#!/bin/sh",
    "# vterm:",
    `#   name: ${name}`,
    `#   description: ${description}`,
    "#   os: [debian, ubuntu, rhel]",
    "#   sudo: true",
    "#   check: true",
    "#   params:",
    "#     NAME: { label: Name, default: example }",
    "set -eu",
    "",
    "# 0 — already so, 1 — would change; print what.",
    "check() {",
    '  [ -e "/etc/$NAME" ] && { echo "already so"; return 0; }',
    '  echo "would create /etc/$NAME"; return 1',
    "}",
    "",
    "apply() {",
    '  touch "/etc/$NAME"',
    '  echo "created /etc/$NAME"',
    "}",
    "",
    'case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac',
    "",
  ].join("\n");
}

/**
 * A new playbook to start from (ADR 0072): its description as the comment at
 * its top, one play on every host of the run, one task that asks each host to
 * answer. The servers are the catalog's, picked when it runs.
 */
export function playbookTemplate(name: string, description: string): string {
  return [
    `# ${description.replace(/\n/g, " ")}`,
    `- name: ${JSON.stringify(name.replace(/\n/g, " "))}`,
    "  hosts: all",
    "  become: false",
    "  tasks:",
    "    - name: The host answers",
    "      ansible.builtin.ping:",
    "",
  ].join("\n");
}

/**
 * A script made elsewhere (the assistant's, from a recording) as a recipe: the
 * header added, the body run as `apply`. A script that already has a header is
 * kept as it is.
 */
export function asRecipe(script: string, name: string, description: string): string {
  if (parseRecipe(script).ok) return script;
  const body = script
    .replace(/\r\n?/g, "\n")
    .replace(/^#![^\n]*\n/, "")
    .trimEnd();
  return [
    "#!/bin/sh",
    "# vterm:",
    `#   name: ${name.replace(/\n/g, " ")}`,
    `#   description: ${description.replace(/\n/g, " ")}`,
    "#   sudo: false",
    "apply() {",
    ...body.split("\n").map((l) => (l ? `  ${l}` : l)),
    "}",
    "",
    'case "${VTERM_MODE:-apply}" in check) echo "this recipe cannot check"; exit 2 ;; *) apply ;; esac',
    "",
  ].join("\n");
}
