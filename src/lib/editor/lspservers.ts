// Which language server a file gets and where its project starts (ADR 0079).
// The servers are the catalogue of `lsp.rs` — the window names one by id, the
// backend knows its program. A project's root is the nearest folder above the
// file with the language's marker (Cargo.toml, go.mod, pyproject.toml…); none —
// the file's own folder.

import type { EditorLangKind } from "./editorlang";

export interface LspServerInfo {
  id: string;
  /** The program, as the status bar and the install offer name it. */
  program: string;
}

const S = (id: string, program: string): LspServerInfo => ({ id, program });

const PY = [S("basedpyright", "basedpyright"), S("pyright", "pyright"), S("pylsp", "pylsp")];
const YAML = [S("yaml-language-server", "yaml-language-server")];

/** The servers for a language, the first installed one is used. */
const BY_KIND: Partial<Record<EditorLangKind, LspServerInfo[]>> = {
  python: PY,
  rust: [S("rust-analyzer", "rust-analyzer")],
  go: [S("gopls", "gopls")],
  hcl: [S("terraform-ls", "terraform-ls")],
  yaml: YAML,
  compose: YAML,
  ghactions: YAML,
  prometheus: YAML,
  k8s: YAML,
  ansible: [S("ansible-language-server", "ansible-language-server"), ...YAML],
  shell: [S("bash-language-server", "bash-language-server")],
  javascript: [S("typescript-language-server", "typescript-language-server")],
  typescript: [S("typescript-language-server", "typescript-language-server")],
  dockerfile: [S("docker-langserver", "docker-langserver")],
  c: [S("clangd", "clangd")],
  cpp: [S("clangd", "clangd")],
};

/** The servers a file of `kind` may use; a Helm template gets helm_ls first. */
export function serversFor(kind: EditorLangKind, path: string): LspServerInfo[] {
  const list = BY_KIND[kind] ?? [];
  if ((kind === "yaml" || kind === "k8s") && /(^|[/\\])templates[/\\][^/\\]+\.(ya?ml|tpl)$/.test(path)) return [S("helm_ls", "helm_ls"), ...list];
  return list;
}

/** The files that make a folder the root of a project of `kind`. */
export function rootMarkers(kind: EditorLangKind): string[] {
  switch (kind) {
    case "python":
      return ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"];
    case "rust":
      return ["Cargo.toml"];
    case "go":
      return ["go.work", "go.mod"];
    case "javascript":
    case "typescript":
      return ["package.json", "tsconfig.json", "jsconfig.json"];
    case "ansible":
      return ["ansible.cfg", ".ansible-lint"];
    case "c":
    case "cpp":
      return ["compile_commands.json", "CMakeLists.txt", ".clangd"];
    default:
      return [".git"];
  }
}

/** How many folders up the root is looked for. */
export const ROOT_LEVELS = 8;

const parent = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i <= 0) return p.startsWith("/") ? "/" : p;
  if (/^[A-Za-z]:$/.test(p.slice(0, i))) return p.slice(0, i + 1);
  return p.slice(0, i);
};

/** The folders above a file, nearest first, up to {@link ROOT_LEVELS}. */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  let cur = parent(path);
  for (let n = 0; n < ROOT_LEVELS; n++) {
    out.push(cur);
    const up = parent(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

/**
 * The project's root for a file: the nearest folder holding a marker, by the
 * listings `list` gives (a folder that cannot be listed counts as without one).
 * For Rust the outermost `Cargo.toml` within reach — a workspace holds its crates.
 */
export async function findRoot(path: string, kind: EditorLangKind, list: (dir: string) => Promise<string[]>): Promise<string> {
  const markers = rootMarkers(kind);
  let found: string | null = null;
  for (const dir of ancestors(path)) {
    let names: string[];
    try {
      names = await list(dir);
    } catch {
      continue;
    }
    if (markers.some((m) => names.includes(m))) {
      found = dir;
      if (kind !== "rust") break;
    } else if (kind === "rust" && found) {
      break;
    }
  }
  return found ?? parent(path);
}

/** The `file://` URI of a path, a Windows path with its drive. */
export function fileUri(path: string): string {
  const p = path.replace(/\\/g, "/");
  const withSlash = /^[A-Za-z]:/.test(p) ? `/${p}` : p;
  return "file://" + withSlash.split("/").map((seg) => encodeURIComponent(seg).replace(/%3A/g, ":")).join("/");
}

/** The LSP `languageId` of a kind. */
export function languageId(kind: EditorLangKind): string {
  switch (kind) {
    case "hcl":
      return "terraform";
    case "shell":
      return "shellscript";
    case "compose":
    case "ghactions":
    case "prometheus":
    case "k8s":
      return "yaml";
    case "ansible":
      return "ansible";
    default:
      return kind;
  }
}

/** The key a server is remembered under to start by itself: host, folder and server. */
export function lspKey(host: string, root: string, server: string): string {
  return `${host}|${root}|${server}`;
}
