// `.editorconfig` (ADR 0076): which files to read for a path, how one file
// parses, and what applies — by the spec (editorconfig.org): files are found
// from the file's folder upwards until one says `root = true`, the nearest one
// wins, and a section's glob without a slash matches the name in any folder.
// Pure: the editor reads the files through its connection and hands the texts
// here.

/** What the editor uses of a `.editorconfig`; the rest is ignored. */
export interface EditorConfigProps {
  tabs?: boolean;
  width?: number;
  trimTrailing?: boolean;
  finalNewline?: boolean;
  eol?: "lf" | "crlf";
}

export interface ParsedEditorConfig {
  root: boolean;
  sections: { glob: string; props: Record<string, string> }[];
}

/** How many folders up the search goes before it gives up. */
export const MAX_LEVELS = 12;

const norm = (p: string) => p.replace(/\\/g, "/");

/**
 * The `.editorconfig` paths to try for `filePath`, nearest first, in the path's
 * own separator style (a local Windows path keeps its backslashes).
 */
export function editorconfigPaths(filePath: string): string[] {
  const win = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\");
  const sepc = win && filePath.includes("\\") ? "\\" : "/";
  const parts = norm(filePath).split("/");
  parts.pop();
  const out: string[] = [];
  while (parts.length > 0 && out.length < MAX_LEVELS) {
    const dir = parts.join("/");
    out.push((dir === "" ? "" : dir) + "/.editorconfig");
    if (dir === "" || /^[A-Za-z]:$/.test(dir)) break;
    parts.pop();
  }
  return sepc === "\\" ? out.map((p) => p.replace(/\//g, "\\")) : out;
}

/** One `.editorconfig` text, by the INI rules the spec gives. */
export function parseEditorConfig(text: string): ParsedEditorConfig {
  const out: ParsedEditorConfig = { root: false, sections: [] };
  let current: { glob: string; props: Record<string, string> } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[(.*)\]$/.exec(line);
    if (head) {
      current = { glob: head[1], props: {} };
      out.sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!current) {
      if (key === "root") out.root = value.toLowerCase() === "true";
      continue;
    }
    current.props[key] = value;
  }
  return out;
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g;
const esc = (s: string) => s.replace(SPECIAL, "\\$&");

/** A section glob as a regular expression over a `/`-separated relative path. */
export function globRegex(glob: string): RegExp {
  let g = glob;
  if (g.startsWith("/")) g = g.slice(1);
  else if (!g.includes("/")) g = "**/" + g;
  let re = "";
  let i = 0;
  let braces = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` — any number of folders, none included.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      const end = g.indexOf("]", i + 1);
      if (end < 0) {
        re += "\\[";
        i++;
        continue;
      }
      let body = g.slice(i + 1, end);
      const neg = body.startsWith("!");
      if (neg) body = body.slice(1);
      re += "[" + (neg ? "^" : "") + body.replace(/[\\\]^]/g, "\\$&") + "]";
      i = end + 1;
    } else if (c === "{") {
      const end = g.indexOf("}", i + 1);
      const body = end < 0 ? "" : g.slice(i + 1, end);
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const nums: string[] = [];
        for (let n = lo; n <= hi && nums.length < 1000; n++) nums.push(String(n));
        re += "(?:" + nums.join("|") + ")";
        i = end + 1;
      } else if (end >= 0 && body.includes(",")) {
        re += "(?:";
        braces++;
        i++;
      } else {
        re += "\\{";
        i++;
      }
    } else if (c === "," && braces > 0) {
      re += "|";
      i++;
    } else if (c === "}" && braces > 0) {
      re += ")";
      braces--;
      i++;
    } else {
      re += esc(c);
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * What applies to `filePath`, given the `.editorconfig` files found for it —
 * nearest first, each with the folder it sits in. Files beyond the first
 * `root = true` are not consulted; nearer files override farther ones.
 */
export function resolveEditorConfig(
  filePath: string,
  found: readonly { dir: string; parsed: ParsedEditorConfig }[],
): EditorConfigProps {
  const chain: { dir: string; parsed: ParsedEditorConfig }[] = [];
  for (const f of found) {
    chain.push(f);
    if (f.parsed.root) break;
  }
  const file = norm(filePath);
  const merged: Record<string, string> = {};
  for (const { dir, parsed } of chain.reverse()) {
    const base = norm(dir).replace(/\/$/, "");
    if (!file.startsWith(base + "/")) continue;
    const rel = file.slice(base.length + 1);
    for (const s of parsed.sections) {
      if (globRegex(s.glob).test(rel)) Object.assign(merged, s.props);
    }
  }
  const out: EditorConfigProps = {};
  const style = merged.indent_style?.toLowerCase();
  if (style === "tab") out.tabs = true;
  else if (style === "space") out.tabs = false;
  const size = merged.indent_size?.toLowerCase();
  const tabWidth = Number(merged.tab_width);
  if (size === "tab") {
    if (Number.isInteger(tabWidth) && tabWidth > 0 && tabWidth <= 16) out.width = tabWidth;
  } else if (size !== undefined) {
    const n = Number(size);
    if (Number.isInteger(n) && n > 0 && n <= 16) out.width = n;
  } else if (out.tabs && Number.isInteger(tabWidth) && tabWidth > 0 && tabWidth <= 16) {
    out.width = tabWidth;
  }
  const bool = (v: string | undefined) => (v === undefined ? undefined : v.toLowerCase() === "true");
  const trim = bool(merged.trim_trailing_whitespace);
  if (trim !== undefined) out.trimTrailing = trim;
  const fin = bool(merged.insert_final_newline);
  if (fin !== undefined) out.finalNewline = fin;
  const eol = merged.end_of_line?.toLowerCase();
  if (eol === "lf" || eol === "crlf") out.eol = eol;
  return out;
}

/** The folder of an `.editorconfig` path. */
export function editorconfigDir(path: string): string {
  const n = norm(path);
  const dir = n.slice(0, n.lastIndexOf("/"));
  return dir === "" ? "/" : dir;
}
