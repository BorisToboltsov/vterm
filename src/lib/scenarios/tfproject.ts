// A Terraform project as its overview shows it (ADR 0071): the resources,
// data sources, modules, variables and outputs its `.tf` files declare, the
// backend that keeps its state, the providers its lock file pins — read from
// the text, without Terraform. A scanner, not a full HCL parser: it walks the
// blocks at the top of a file and the simple `key = value` lines inside them,
// skipping strings, comments and heredocs, so a brace inside a string or a
// comment never closes a block. Pure.

export interface TfVariable {
  name: string;
  /** `default = …` as written, or null — the plan asks for it (or a .tfvars gives it). */
  default: string | null;
  type: string | null;
  description: string | null;
  sensitive: boolean;
}

export interface TfProject {
  resources: { type: string; name: string; counted: boolean }[];
  data: { type: string; name: string }[];
  modules: { name: string; source: string | null }[];
  variables: TfVariable[];
  outputs: { name: string; sensitive: boolean }[];
  /** `terraform { backend "<kind>" }`; null — local state. */
  backend: string | null;
  /** `required_providers` names → source as written. */
  providers: Record<string, string>;
}

export const emptyProject = (): TfProject => ({
  resources: [],
  data: [],
  modules: [],
  variables: [],
  outputs: [],
  backend: null,
  providers: {},
});

interface Block {
  kind: string;
  labels: string[];
  /** `key = value` lines directly inside, value as written (one line). */
  attrs: Record<string, string>;
  children: Block[];
}

/** Text with strings, comments and heredocs blanked out — braces in them do not count. */
function blankNoise(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < n && src[i] !== "\n") out += src[i++] === "\t" ? "\t" : " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "<" && src[i + 1] === "<") {
      const m = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\n/.exec(src.slice(i));
      if (m) {
        const re = new RegExp(`\\n[ \\t]*${m[1]}[ \\t]*(?=\\n|$)`, "g");
        re.lastIndex = i + m[0].length - 1;
        const end = re.exec(src);
        const stop = end ? end.index + end[0].length : n;
        // Keep the heredoc as one blank value so `x = <<EOF` still reads as an attribute.
        out += '""';
        for (i += 2; i < stop; i++) if (src[i] === "\n") out += "\n";
        continue;
      }
    }
    if (c === '"') {
      // Keep the string (labels and values are strings) but blank its insides' braces.
      out += c;
      i++;
      while (i < n && src[i] !== '"' && src[i] !== "\n") {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "{" || src[i] === "}" ? "_" : src[i];
        i++;
      }
      if (i < n && src[i] === '"') out += src[i++];
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const unquote = (v: string): string => v.trim().replace(/^"(.*)"$/, "$1");

interface Tok {
  k: "id" | "str" | "{" | "}" | "[" | "]" | "(" | ")" | "=" | "nl" | "x";
  v: string;
  at: number;
  end: number;
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_-]*)|("[^"\n]*")|([{}[\]()=])|(\n)|([^\s])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index;
    const end = at + m[0].length;
    if (m[1]) out.push({ k: "id", v: m[1], at, end });
    else if (m[2]) out.push({ k: "str", v: m[2].slice(1, -1), at, end });
    else if (m[3]) {
      // `==`, `<=`, `>=`, `!=`, `=>` are operators of an expression, not an assignment.
      const prev = text[at - 1];
      const next = text[at + 1];
      const op = m[3] === "=" && (next === "=" || next === ">" || prev === "=" || prev === "<" || prev === ">" || prev === "!");
      out.push({ k: op ? "x" : (m[3] as Tok["k"]), v: m[3], at, end });
    } else if (m[4]) out.push({ k: "nl", v: "\n", at, end });
    else out.push({ k: "x", v: m[5], at, end });
  }
  return out;
}

/** The blocks of a file, nested. An object value written over several lines
 *  (`hcloud = { … }`) is read as a block of its name — `required_providers`
 *  is written so. */
export function scanBlocks(src: string): Block[] {
  const text = blankNoise(src);
  const toks = tokens(text);
  const root: Block = { kind: "", labels: [], attrs: {}, children: [] };
  const stack: Block[] = [root];
  let i = 0;
  const n = toks.length;
  while (i < n) {
    const tk = toks[i];
    const top = stack[stack.length - 1];
    if (tk.k === "}") {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (tk.k !== "id") {
      i++;
      continue;
    }
    // A block: name, labels, `{`.
    let j = i + 1;
    const labels: string[] = [];
    while (j < n && (toks[j].k === "str" || toks[j].k === "id")) labels.push(toks[j++].v);
    if (j < n && toks[j].k === "{") {
      const b: Block = { kind: tk.v, labels, attrs: {}, children: [] };
      top.children.push(b);
      stack.push(b);
      i = j + 1;
      continue;
    }
    // An attribute: name `=` value up to the end of its line, brackets balanced.
    if (i + 1 < n && toks[i + 1].k === "=") {
      let k = i + 2;
      if (k < n && toks[k].k === "{" && (k + 1 >= n || toks[k + 1].k === "nl")) {
        // An object over several lines: its own block, its attributes inside.
        const b: Block = { kind: tk.v, labels: [], attrs: {}, children: [] };
        top.children.push(b);
        stack.push(b);
        i = k + 1;
        continue;
      }
      let depth = 0;
      const start = k < n ? toks[k].at : text.length;
      let end = start;
      for (; k < n; k++) {
        const t = toks[k];
        if (t.k === "{" || t.k === "[" || t.k === "(") depth++;
        else if (t.k === "}" || t.k === "]" || t.k === ")") {
          if (depth === 0) break;
          depth--;
        } else if (t.k === "nl" && depth === 0) break;
        end = t.end;
      }
      top.attrs[tk.v] = text.slice(start, end).replace(/\s+/g, " ").trim();
      i = k;
      continue;
    }
    i++;
  }
  return root.children;
}

/** What a set of `.tf` files declares, across the files. */
export function readProject(files: readonly string[]): TfProject {
  const p = emptyProject();
  for (const src of files) {
    for (const b of scanBlocks(src)) {
      const [a, c] = b.labels;
      switch (b.kind) {
        case "resource":
          if (a && c) p.resources.push({ type: a, name: c, counted: "count" in b.attrs || "for_each" in b.attrs });
          break;
        case "data":
          if (a && c) p.data.push({ type: a, name: c });
          break;
        case "module":
          if (a) p.modules.push({ name: a, source: b.attrs.source ? unquote(b.attrs.source) : null });
          break;
        case "variable":
          if (a)
            p.variables.push({
              name: a,
              default: b.attrs.default ?? null,
              type: b.attrs.type ?? null,
              description: b.attrs.description ? unquote(b.attrs.description) : null,
              sensitive: b.attrs.sensitive === "true",
            });
          break;
        case "output":
          if (a) p.outputs.push({ name: a, sensitive: b.attrs.sensitive === "true" });
          break;
        case "terraform":
          for (const ch of b.children) {
            if (ch.kind === "backend" && ch.labels[0]) p.backend = ch.labels[0];
            if (ch.kind === "cloud") p.backend = "cloud";
            if (ch.kind === "required_providers") {
              for (const [name, v] of Object.entries(ch.attrs)) {
                const src = /source\s*=\s*"([^"]+)"/.exec(v);
                p.providers[name] = src ? src[1] : unquote(v);
              }
              for (const sub of ch.children) p.providers[sub.kind] = sub.attrs.source ? unquote(sub.attrs.source) : "";
            }
          }
          break;
      }
    }
  }
  return p;
}

/** The providers a `.terraform.lock.hcl` pins: address → version. */
export function lockedProviders(lock: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of scanBlocks(lock)) {
    if (b.kind === "provider" && b.labels[0] && b.attrs.version) out[b.labels[0].replace(/^registry\.terraform\.io\//, "")] = unquote(b.attrs.version);
  }
  return out;
}

/** The `.tfvars` files of a folder's listing, the auto-loaded first. */
export function varFiles(names: readonly string[]): string[] {
  const auto = names.filter((n) => n === "terraform.tfvars" || n === "terraform.tfvars.json" || /\.auto\.tfvars(\.json)?$/.test(n));
  const rest = names.filter((n) => /\.tfvars(\.json)?$/.test(n) && !auto.includes(n)).sort();
  return [...auto.sort(), ...rest];
}

/** Whether `.tfvars` is loaded by Terraform without `-var-file`. */
export const autoLoaded = (name: string): boolean =>
  name === "terraform.tfvars" || name === "terraform.tfvars.json" || /\.auto\.tfvars(\.json)?$/.test(name);
