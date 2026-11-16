// What a folder in the file panel is, and what each of its entries is to it
// (ADR 0077) — the way an IDE marks a project when it opens one: sources,
// tests, the manifest, the entry point, what is generated and what holds
// secrets. From the names in the listing and the folder's path alone; nothing
// is read to decide. The manifest may be read once afterwards for its facts
// (`manifestFacts`), and only for the strip.

import type { IconName } from "../ui/icons";

export type ProjectKind =
  | "ansible"
  | "terraform"
  | "helm"
  | "kustomize"
  | "rust"
  | "go"
  | "python"
  | "node"
  | "compose"
  | "docker"
  | "k8s"
  | "nginx"
  | "systemd";

/** What an entry is to its project. `gen` — made by a tool (dimmed, can be hidden). */
export type Role =
  | "manifest"
  | "lock"
  | "src"
  | "tests"
  | "entry"
  | "entrydir"
  | "gen"
  | "secret"
  | "secretdir"
  | "vars"
  | "inv"
  | "deps"
  | "cfg"
  | "doc"
  | "docker"
  | "k8s"
  | "tf"
  | "tasks"
  | "unit"
  | "timer"
  | "active"
  | "plain";

export interface ProjectEntry {
  name: string;
  isDir: boolean;
}

export interface ProjectInfo {
  kind: ProjectKind;
  /** The names that told it (the strip's tooltip). */
  markers: string[];
  /** The manifest to read for facts, when the kind has one. */
  manifest: string | null;
  /** The file to read for tasks: Makefile, justfile, Taskfile, package.json. */
  tasksFile: string | null;
}

const lower = (s: string) => s.toLowerCase();
const isYaml = (n: string) => /\.ya?ml$/i.test(n);
const has = (names: Set<string>, ...xs: string[]) => xs.find((x) => names.has(x)) ?? null;

const PY_MANIFESTS = ["pyproject.toml", "setup.py", "setup.cfg", "pipfile"];
const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
const K8S_NAMES = /^(deployment|service|ingress|configmap|secret|statefulset|daemonset|cronjob|job|namespace|pvc|hpa|networkpolicy|serviceaccount|role|rolebinding)s?([-_.].*)?\.ya?ml$/i;
const UNIT_EXT = /\.(service|socket|mount|automount|swap|path|slice|target|scope)$/i;
const TASK_FILES = ["makefile", "gnumakefile", "justfile", ".justfile", "taskfile.yml", "taskfile.yaml"];

function underPath(path: string, ...prefixes: string[]): boolean {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return prefixes.some((x) => p === x || p.startsWith(x + "/"));
}

/** The original-case name of a lower-case one in the listing. */
function named(entries: readonly ProjectEntry[], lowerName: string | null): string | null {
  if (!lowerName) return null;
  return entries.find((e) => lower(e.name) === lowerName)?.name ?? null;
}

/**
 * What the folder at `path` is, by its entries — the first kind whose signs it
 * carries, from the most telling: a playbook tree over the `.tf` beside it, a
 * Chart over its YAML, a crate over its Dockerfile. Null — just a folder.
 */
export function projectOf(path: string, entries: readonly ProjectEntry[]): ProjectInfo | null {
  const files = new Set(entries.filter((e) => !e.isDir).map((e) => lower(e.name)));
  const dirs = new Set(entries.filter((e) => e.isDir).map((e) => lower(e.name)));
  const tasks = named(entries, has(files, ...TASK_FILES) ?? (files.has("package.json") ? "package.json" : null));
  const make = (kind: ProjectKind, markers: (string | null)[], manifest: string | null): ProjectInfo => ({
    kind,
    markers: markers.filter((m): m is string => !!m).map((m) => named(entries, lower(m)) ?? m),
    manifest: named(entries, manifest ? lower(manifest) : null),
    tasksFile: tasks,
  });

  if (has(files, "ansible.cfg", "ansible-navigator.yml", "ansible-navigator.yaml")) {
    return make("ansible", [has(files, "ansible.cfg", "ansible-navigator.yml", "ansible-navigator.yaml")], "ansible.cfg");
  }
  const tf = [...files].filter((n) => n.endsWith(".tf"));
  if (tf.length > 0 || files.has(".terraform.lock.hcl")) return make("terraform", tf.slice(0, 3), has(files, "versions.tf", "main.tf"));
  const ansibleDirs = ["group_vars", "host_vars", "roles"].filter((d) => dirs.has(d));
  const playbook = has(files, "site.yml", "site.yaml", "playbook.yml", "playbook.yaml");
  if ((ansibleDirs.length > 0 && ([...files].some(isYaml) || ansibleDirs.length > 1)) || (playbook && (files.has("hosts") || dirs.has("inventory") || dirs.has("inventories")))) {
    return make("ansible", [...ansibleDirs, playbook], null);
  }
  if (files.has("chart.yaml")) return make("helm", ["chart.yaml"], "chart.yaml");
  if (has(files, "kustomization.yaml", "kustomization.yml")) return make("kustomize", [has(files, "kustomization.yaml", "kustomization.yml")], has(files, "kustomization.yaml", "kustomization.yml"));
  if (files.has("cargo.toml")) return make("rust", ["cargo.toml"], "cargo.toml");
  if (files.has("go.mod")) return make("go", ["go.mod"], "go.mod");
  const py = has(files, ...PY_MANIFESTS) ?? [...files].find((n) => /^requirements.*\.txt$/.test(n)) ?? null;
  if (py) return make("python", [py], PY_MANIFESTS.includes(py) && py !== "pipfile" ? py : null);
  if (files.has("package.json")) return make("node", ["package.json"], "package.json");
  const compose = has(files, ...COMPOSE_NAMES);
  if (compose) return make("compose", [compose], compose);
  if (underPath(path, "/etc/nginx") || files.has("nginx.conf")) return make("nginx", ["nginx.conf"], null);
  const units = [...files].filter((n) => UNIT_EXT.test(n) || n.endsWith(".timer"));
  if (underPath(path, "/etc/systemd", "/lib/systemd", "/usr/lib/systemd") || /\/\.config\/systemd(\/|$)/.test(path) || units.length >= 2) {
    return make("systemd", units.slice(0, 3), null);
  }
  if (has(files, "dockerfile", "containerfile")) return make("docker", [has(files, "dockerfile", "containerfile")], null);
  const manifests = [...files].filter((n) => K8S_NAMES.test(n));
  if (manifests.length >= 2) return make("k8s", manifests.slice(0, 3), null);
  return null;
}

/** Folders and files every kind of project leaves behind — made by a tool. */
const GEN_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".terraform",
  "coverage",
  ".idea",
  ".vscode",
]);

function genericRole(e: ProjectEntry): Role | null {
  const n = lower(e.name);
  if (e.isDir) {
    if (GEN_DIRS.has(n) || n.endsWith(".egg-info")) return "gen";
    if (n === "docs" || n === "doc") return "doc";
    if (n === ".github" || n === ".gitlab") return "cfg";
    return null;
  }
  if (/^(readme|changelog|license|licence|contributing|authors|notice)(\.|$)/.test(n)) return "doc";
  if (/^\.env\.(example|sample|template|dist)$/.test(n)) return "cfg";
  if (n === ".env" || n.startsWith(".env.")) return "secret";
  if (/\.(pem|key|p12|pfx|jks|kdbx)$/.test(n) || /^id_(rsa|ed25519|ecdsa|dsa)$/.test(n)) return "secret";
  if (n === "dockerfile" || n === "containerfile" || n.startsWith("dockerfile.") || n.endsWith(".dockerfile")) return "docker";
  if (COMPOSE_NAMES.includes(n)) return "docker";
  if (TASK_FILES.includes(n)) return "tasks";
  if (/^\.(gitignore|gitattributes|editorconfig|dockerignore|gitlab-ci\.ya?ml|pre-commit-config\.ya?ml)$/.test(n) || /^\.[\w.-]+rc(\.\w+)?$/.test(n)) return "cfg";
  if (n.endsWith(".md")) return "doc";
  return null;
}

function kindRole(kind: ProjectKind, e: ProjectEntry): Role | null {
  const n = lower(e.name);
  const d = e.isDir;
  switch (kind) {
    case "ansible":
      if (d) {
        if (n === "roles" || n === "library" || n === "filter_plugins" || n === "module_utils" || n === "plugins" || n === "playbooks") return "src";
        if (n === "group_vars" || n === "host_vars" || n === "vars") return "vars";
        if (n === "inventory" || n === "inventories") return "inv";
        if (n === "molecule" || n === "tests") return "tests";
        if (n === "collections") return "gen";
        return null;
      }
      if (n === "ansible.cfg") return "manifest";
      if (/vault/.test(n) && isYaml(n)) return "secret";
      if (n === "requirements.yml" || n === "requirements.yaml" || n === "galaxy.yml") return "deps";
      if (n === "hosts" || /^(hosts|inventory)\.(ini|ya?ml)$/.test(n)) return "inv";
      if (isYaml(n) && !/^(\.ansible-lint|ansible-navigator)/.test(n)) return "entry";
      return null;
    case "terraform":
      if (d) return n === "modules" ? "src" : null;
      if (n === ".terraform.lock.hcl") return "lock";
      if (/\.tfstate(\.backup)?$/.test(n) || /\.tfvars(\.json)?$/.test(n)) return "secret";
      if (n === "tfplan" || n.endsWith(".tfplan")) return "gen";
      if (n === "main.tf") return "entry";
      if (n === "versions.tf") return "manifest";
      if (n === "backend.tf" || n === "providers.tf" || n === "provider.tf") return "cfg";
      if (n.endsWith(".tf")) return "tf";
      return null;
    case "helm":
      if (d) {
        if (n === "templates" || n === "crds") return "src";
        if (n === "charts") return "gen";
        if (n === "ci" || n === "tests") return "tests";
        return null;
      }
      if (n === "chart.yaml") return "manifest";
      if (n === "chart.lock") return "lock";
      if (/^values.*\.ya?ml$/.test(n)) return "vars";
      if (n === "values.schema.json" || n === ".helmignore") return "cfg";
      return null;
    case "kustomize":
    case "k8s":
      if (d) {
        if (n === "base" || n === "overlays" || n === "patches" || n === "components") return "src";
        if (n === "configs" || n === "config") return "vars";
        return null;
      }
      if (n === "kustomization.yaml" || n === "kustomization.yml") return "manifest";
      if (n.endsWith(".env") && /secret/.test(n)) return "secret";
      if (isYaml(n)) return "k8s";
      return null;
    case "rust":
      if (d) {
        if (n === "src" || n === "examples" || n === "crates") return "src";
        if (n === "tests" || n === "benches") return "tests";
        if (n === "target") return "gen";
        if (n === ".cargo") return "cfg";
        return null;
      }
      if (n === "cargo.toml") return "manifest";
      if (n === "cargo.lock") return "lock";
      if (/^(build\.rs|rustfmt\.toml|\.rustfmt\.toml|clippy\.toml|deny\.toml|rust-toolchain(\.toml)?)$/.test(n)) return "cfg";
      return null;
    case "go":
      if (d) {
        if (n === "cmd") return "entrydir";
        if (n === "internal" || n === "pkg" || n === "api") return "src";
        if (n === "testdata") return "tests";
        if (n === "vendor" || n === "bin") return "gen";
        return null;
      }
      if (n === "go.mod" || n === "go.work") return "manifest";
      if (n === "go.sum" || n === "go.work.sum") return "lock";
      if (n.endsWith("_test.go")) return "tests";
      if (n === "main.go") return "entry";
      if (/^\.golangci\.ya?ml$/.test(n)) return "cfg";
      return null;
    case "python":
      if (d) {
        if (n === "src" || n === "app" || n === "lib") return "src";
        if (n === "tests" || n === "test") return "tests";
        if (n === "dist" || n === "build" || n === "env" || n === "htmlcov") return "gen";
        return null;
      }
      if (PY_MANIFESTS.includes(n)) return "manifest";
      if (/^requirements.*\.txt$/.test(n)) return "deps";
      if (/^(uv|poetry|pdm)\.lock$|^pipfile\.lock$/.test(n)) return "lock";
      if (/^(manage|main|app|wsgi|asgi|__main__)\.py$/.test(n)) return "entry";
      if (/^(tox|pytest|mypy)\.ini$|^\.python-version$|^ruff\.toml$|^\.ruff\.toml$/.test(n)) return "cfg";
      if (/^test_.*\.py$|_test\.py$/.test(n)) return "tests";
      return null;
    case "node":
      if (d) {
        if (n === "src" || n === "lib" || n === "app" || n === "pages" || n === "public" || n === "server") return "src";
        if (n === "test" || n === "tests" || n === "__tests__" || n === "e2e" || n === "spec") return "tests";
        if (n === "dist" || n === "build" || n === "out") return "gen";
        return null;
      }
      if (n === "package.json") return "manifest";
      if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/.test(n)) return "lock";
      if (/^(tsconfig.*\.json|jsconfig\.json|\.nvmrc|\.node-version|\.npmrc|pnpm-workspace\.yaml)$/.test(n) || /\.config\.(c|m)?(js|ts)$/.test(n)) return "cfg";
      if (/^(index|server|main|app)\.(c|m)?(js|ts)$/.test(n)) return "entry";
      if (/\.(test|spec)\.(c|m)?(js|ts)x?$/.test(n)) return "tests";
      return null;
    case "compose":
    case "docker":
      if (d) return n === "data" || n === "volumes" ? "gen" : n === "scripts" || n === "config" || n === "conf" ? "src" : null;
      if (COMPOSE_NAMES.includes(n)) return kind === "compose" ? "manifest" : "docker";
      if (/^(docker-)?compose\..+\.ya?ml$/.test(n)) return "cfg";
      if ((n === "dockerfile" || n === "containerfile") && kind === "docker") return "manifest";
      return null;
    case "nginx":
      if (d) {
        if (n === "sites-enabled" || n === "conf-enabled") return "active";
        if (n === "modules-enabled" || n === "modules-available") return "gen";
        if (n === "ssl" || n === "certs" || n === "private") return "secretdir";
        if (n === "sites-available" || n === "conf.d" || n === "snippets") return "src";
        return null;
      }
      if (n === "nginx.conf") return "manifest";
      return null;
    case "systemd":
      if (d) {
        if (/\.(wants|requires|upholds)$/.test(n)) return "active";
        if (n.endsWith(".d")) return "vars";
        return null;
      }
      if (n.endsWith(".timer")) return "timer";
      if (UNIT_EXT.test(n)) return "unit";
      return null;
  }
}

/** What `entry` is to a project of `kind`; outside a project — what any folder says. */
export function roleOf(kind: ProjectKind | null, entry: ProjectEntry): Role {
  return (kind ? kindRole(kind, entry) : null) ?? genericRole(entry) ?? "plain";
}

/** Whether a role is made by a tool — dimmed, and hidden by «Hide generated». */
export const isGenerated = (r: Role): boolean => r === "gen";

/** A colour of the theme for a mark (`text-*` classes are picked by the component). */
export type Tone = "accent" | "ok" | "warn" | "muted" | "violet" | null;

/** How a row looks in the «as in an IDE» view: its icon, the icon's tone, and what follows the name. */
export interface RowLook {
  icon: IconName;
  tone: Tone;
  /** The name in the warning tone (a secret). */
  warnName: boolean;
  /** The name bold (the manifest). */
  strong: boolean;
  dim: boolean;
  /** A small mark after the name: the entry point, an enabled link. */
  after: "entry" | "link" | null;
}

/** The icon a file gets by its name — the language it is in, for a few, a category for the rest. */
export function fileGlyph(name: string): { icon: IconName; tone: Tone } {
  const n = lower(name);
  if (n.endsWith(".py")) return { icon: "langPython", tone: "accent" };
  if (n.endsWith(".rs")) return { icon: "langRust", tone: "accent" };
  if (n.endsWith(".go")) return { icon: "langGo", tone: "accent" };
  if (/\.(c|m)?(js|ts)x?$/.test(n)) return { icon: "langNode", tone: "ok" };
  if (/\.(tf|tfvars|hcl)$/.test(n)) return { icon: "cube", tone: "accent" };
  if (n.endsWith(".md")) return { icon: "markdown", tone: null };
  if (n === "dockerfile" || n === "containerfile" || n.startsWith("dockerfile.")) return { icon: "container", tone: "accent" };
  if (/\.(sh|bash|zsh|ps1)$/.test(n)) return { icon: "terminal", tone: null };
  if (/\.(ya?ml|toml|ini|cfg|conf|json|jsonc|env|properties|xml)$/.test(n) || n.startsWith(".")) return { icon: "braces", tone: null };
  return { icon: "file", tone: null };
}

/** The «as in an IDE» look of a row with role `role`. */
export function rowLook(entry: ProjectEntry, role: Role, kind: ProjectKind | null): RowLook {
  const base: RowLook = { icon: entry.isDir ? "folder" : fileGlyph(entry.name).icon, tone: entry.isDir ? null : fileGlyph(entry.name).tone, warnName: false, strong: false, dim: false, after: null };
  if (kind === "ansible" && !entry.isDir && isYaml(entry.name)) base.icon = "gearPlay";
  switch (role) {
    case "manifest":
      return { ...base, icon: "manifest", tone: "accent", strong: true };
    case "lock":
      return { ...base, tone: "muted" };
    case "src":
      return entry.isDir ? { ...base, icon: "folderCode", tone: "accent" } : base;
    case "entrydir":
      return { ...base, icon: "folderCode", tone: "accent", after: "entry" };
    case "tests":
      return entry.isDir ? { ...base, icon: "folderTest", tone: "ok" } : { ...base, tone: "ok" };
    case "entry":
      return { ...base, tone: kind === "ansible" ? "warn" : base.tone, after: "entry" };
    case "gen":
      return { ...base, icon: entry.isDir ? "folderOff" : base.icon, tone: "muted", dim: true };
    case "secret":
      return { ...base, icon: "lock", tone: "warn", warnName: true };
    case "secretdir":
      return { ...base, icon: "lock", tone: "warn" };
    case "vars":
      return entry.isDir ? { ...base, icon: "folderVars", tone: "violet" } : { ...base, icon: "braces", tone: "violet" };
    case "inv":
      return { ...base, icon: "server", tone: "violet" };
    case "deps":
      return { ...base, icon: "listCheck", tone: null };
    case "docker":
      return { ...base, icon: "container", tone: "accent" };
    case "k8s":
      return { ...base, icon: "kubernetes", tone: "accent" };
    case "tf":
      return { ...base, icon: "cube", tone: "accent" };
    case "tasks":
      return { ...base, icon: "listCheck", tone: "accent" };
    case "unit":
      return { ...base, icon: "unit", tone: "accent" };
    case "timer":
      return { ...base, icon: "clock", tone: "accent" };
    case "active":
      return { ...base, tone: "ok", after: "link" };
    case "doc":
      return entry.isDir ? base : { ...base, icon: entry.name.toLowerCase().endsWith(".md") ? "markdown" : "note" };
    default:
      return base;
  }
}

/** The icon of each kind of project, for the strip. */
export const KIND_ICON: Record<ProjectKind, { icon: IconName; tone: Tone }> = {
  ansible: { icon: "gearPlay", tone: "warn" },
  terraform: { icon: "cube", tone: "accent" },
  helm: { icon: "helm", tone: "accent" },
  kustomize: { icon: "kubernetes", tone: "accent" },
  k8s: { icon: "kubernetes", tone: "accent" },
  rust: { icon: "langRust", tone: "accent" },
  go: { icon: "langGo", tone: "accent" },
  python: { icon: "langPython", tone: "accent" },
  node: { icon: "langNode", tone: "ok" },
  compose: { icon: "container", tone: "accent" },
  docker: { icon: "container", tone: "accent" },
  nginx: { icon: "server", tone: "accent" },
  systemd: { icon: "unit", tone: "accent" },
};

/** The name a kind is shown with — a technical name, not translated. */
export const KIND_LABEL: Record<ProjectKind, string> = {
  ansible: "Ansible",
  terraform: "Terraform",
  helm: "Helm",
  kustomize: "Kustomize",
  k8s: "Kubernetes",
  rust: "Rust",
  go: "Go",
  python: "Python",
  node: "Node",
  compose: "Compose",
  docker: "Docker",
  nginx: "nginx",
  systemd: "systemd",
};

/** What a manifest says: a name and version for the strip's title, and short technical facts. */
export interface ManifestFacts {
  name: string | null;
  version: string | null;
  facts: string[];
  /** Rust edition (rustfmt's `--edition`). */
  edition?: string;
}

function tomlSection(text: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      cur = sec[1].trim();
      continue;
    }
    if (cur !== section) continue;
    const kv = /^([\w.-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function yamlTop(text: string, key: string): string | null {
  const m = new RegExp(`^${key}:\\s*["']?([^"'\\n#]+?)["']?\\s*(#.*)?$`, "m").exec(text);
  return m ? m[1].trim() : null;
}

/** The facts of a manifest's text (read once, small); unknown shapes say nothing. */
export function manifestFacts(kind: ProjectKind, manifest: string, text: string): ManifestFacts {
  const out: ManifestFacts = { name: null, version: null, facts: [manifest] };
  switch (kind) {
    case "rust": {
      const pkg = tomlSection(text, "package");
      out.name = pkg.name ?? null;
      out.version = pkg.version ?? null;
      if (pkg.edition) {
        out.edition = pkg.edition;
        out.facts.push(`edition ${pkg.edition}`);
      }
      if (/^\[workspace\]/m.test(text)) out.facts.push("workspace");
      break;
    }
    case "python": {
      const p = tomlSection(text, "project");
      const poetry = tomlSection(text, "tool.poetry");
      out.name = p.name ?? poetry.name ?? null;
      out.version = p.version ?? poetry.version ?? null;
      if (p["requires-python"]) out.facts.push(`Python ${p["requires-python"]}`);
      for (const tool of ["pytest", "ruff", "mypy", "black"]) {
        if (new RegExp(`^\\[tool\\.${tool}(\\.|\\])`, "m").test(text)) out.facts.push(tool);
      }
      break;
    }
    case "go": {
      out.name = /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
      const v = /^go\s+(\d[\w.]*)/m.exec(text)?.[1];
      if (out.name) out.facts.push(out.name);
      if (v) out.facts.push(`go ${v}`);
      out.name = out.name?.split("/").pop() ?? null;
      break;
    }
    case "node": {
      try {
        const pkg = JSON.parse(text) as Record<string, unknown>;
        out.name = typeof pkg.name === "string" ? pkg.name : null;
        out.version = typeof pkg.version === "string" ? pkg.version : null;
        const engines = pkg.engines as Record<string, unknown> | undefined;
        if (engines && typeof engines.node === "string") out.facts.push(`node ${engines.node}`);
        if (typeof pkg.packageManager === "string") out.facts.push(pkg.packageManager.split("@")[0]);
      } catch {
        // Not JSON yet (being written): the strip shows the file's name and nothing more.
        return out;
      }
      break;
    }
    case "helm": {
      out.name = yamlTop(text, "name");
      out.version = yamlTop(text, "version");
      const app = yamlTop(text, "appVersion");
      if (app) out.facts.push(`appVersion ${app}`);
      const deps = [...text.matchAll(/^\s*-\s*name:\s*["']?([\w.-]+)/gm)].map((m) => m[1]);
      if (deps.length) out.facts.push(deps.slice(0, 3).join(", "));
      break;
    }
    case "compose": {
      const svc = /^services:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(text);
      if (svc) {
        const names = [...svc[1].matchAll(/^ {2}([\w.-]+):/gm)].map((m) => m[1]);
        if (names.length) out.facts.push(names.slice(0, 5).join(", "));
      }
      out.name = yamlTop(text, "name");
      break;
    }
    case "kustomize": {
      const res = /^resources:\s*\n((?:\s*-.*\n?)*)/m.exec(text);
      if (res) out.facts.push(...[...res[1].matchAll(/^\s*-\s*(\S+)/gm)].map((m) => m[1]).filter((r) => r.startsWith("..")).slice(0, 2));
      break;
    }
    default:
      break;
  }
  return out;
}

/** The package manager a Python or Node project uses, by its lock file. */
export function packageManager(kind: ProjectKind, entries: readonly ProjectEntry[]): string | null {
  const files = new Set(entries.filter((e) => !e.isDir).map((e) => lower(e.name)));
  if (kind === "python") {
    if (files.has("uv.lock")) return "uv";
    if (files.has("poetry.lock")) return "poetry";
    if (files.has("pdm.lock")) return "pdm";
    if (files.has("pipfile") || files.has("pipfile.lock")) return "pipenv";
    return "pip";
  }
  if (kind === "node") {
    if (files.has("pnpm-lock.yaml")) return "pnpm";
    if (files.has("yarn.lock")) return "yarn";
    if (files.has("bun.lockb") || files.has("bun.lock")) return "bun";
    return "npm";
  }
  return null;
}
