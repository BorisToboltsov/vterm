// Pure mapping: a remote filename → the editor language used for CodeMirror
// highlighting, and whether vterm opens it in the in-app editor on click.
// Extension-based with a few well-known extensionless/dotfile config names;
// anything editable but unrecognised falls back to plain text.
//
// Language labels are short technical strings (YAML/JSON/TOML/…) and are NOT
// translated — same rule as log-format badges and theme/font names (see the
// i18n section of CLAUDE.md).

/** Highlighting kind; `EditorTab` resolves each to a CodeMirror language. */
export type EditorLangKind =
  | "yaml"
  | "json"
  | "markdown"
  | "shell"
  | "toml"
  | "ini"
  | "python"
  | "javascript"
  | "typescript"
  | "java"
  | "dockerfile"
  | "go"
  | "rust"
  | "ruby"
  | "c"
  | "cpp"
  | "csharp"
  | "sql"
  | "powershell"
  | "lua"
  | "perl"
  // Markup / web
  | "html"
  | "css"
  | "scss"
  | "less"
  | "xml"
  // DevOps / config
  | "nginx"
  | "sshdconfig"
  | "sudoers"
  | "haproxy"
  | "bind"
  | "systemd"
  // YAML-family dialects (Phase B): highlighted as YAML, but each maps to a
  // dedicated server-side validator (docker compose config / actionlint / …).
  | "compose"
  | "ghactions"
  | "prometheus"
  | "ansible"
  | "k8s"
  | "cmake"
  | "diff"
  | "http"
  | "protobuf"
  | "puppet"
  // More languages
  | "groovy"
  | "scala"
  | "kotlin"
  | "dart"
  | "swift"
  | "clojure"
  | "haskell"
  | "erlang"
  | "elm"
  | "crystal"
  | "r"
  | "julia"
  | "coffeescript"
  | "vb"
  | "scheme"
  | "commonlisp"
  | "ocaml"
  | "fsharp"
  | "tcl"
  | "d"
  | "verilog"
  | "vhdl"
  | "pascal"
  | "fortran"
  | "cobol"
  | "plain";

export interface EditorLang {
  kind: EditorLangKind;
  /** Short label shown on the sub-tab (untranslated, technical). */
  label: string;
}

const YAML: EditorLang = { kind: "yaml", label: "YAML" };
const JSON_: EditorLang = { kind: "json", label: "JSON" };
const MD: EditorLang = { kind: "markdown", label: "Markdown" };
const SHELL: EditorLang = { kind: "shell", label: "Shell" };
const TOML: EditorLang = { kind: "toml", label: "TOML" };
const CONFIG: EditorLang = { kind: "ini", label: "Config" };
const TEXT: EditorLang = { kind: "plain", label: "Text" };
const TERRAFORM: EditorLang = { kind: "plain", label: "Terraform" };
const PYTHON: EditorLang = { kind: "python", label: "Python" };
const JS: EditorLang = { kind: "javascript", label: "JavaScript" };
const TS: EditorLang = { kind: "typescript", label: "TypeScript" };
const JAVA: EditorLang = { kind: "java", label: "Java" };
const DOCKER: EditorLang = { kind: "dockerfile", label: "Dockerfile" };
const GO: EditorLang = { kind: "go", label: "Go" };
const RUST: EditorLang = { kind: "rust", label: "Rust" };
const RUBY: EditorLang = { kind: "ruby", label: "Ruby" };
const C: EditorLang = { kind: "c", label: "C" };
const CPP: EditorLang = { kind: "cpp", label: "C++" };
const CSHARP: EditorLang = { kind: "csharp", label: "C#" };
const SQL: EditorLang = { kind: "sql", label: "SQL" };
const POWERSHELL: EditorLang = { kind: "powershell", label: "PowerShell" };
const LUA: EditorLang = { kind: "lua", label: "Lua" };
const PERL: EditorLang = { kind: "perl", label: "Perl" };
const NGINX: EditorLang = { kind: "nginx", label: "nginx" };
// Daemon config validators (Phase A): highlighting is approximate (INI/nginx-like),
// the value is the server-side `-t`-style lint each one enables (see remotelint.ts).
const SSHD: EditorLang = { kind: "sshdconfig", label: "sshd" };
const SUDOERS: EditorLang = { kind: "sudoers", label: "sudoers" };
const HAPROXY: EditorLang = { kind: "haproxy", label: "HAProxy" };
const BIND: EditorLang = { kind: "bind", label: "BIND" };
const SYSTEMD: EditorLang = { kind: "systemd", label: "systemd" };
// YAML-family dialects (Phase B): the file is still YAML (highlighted as such), but
// its name/path/content picks a more specific validator. Labels are technical (not
// translated), like the other badges.
const COMPOSE: EditorLang = { kind: "compose", label: "Compose" };
const GHACTIONS: EditorLang = { kind: "ghactions", label: "Actions" };
const PROMETHEUS: EditorLang = { kind: "prometheus", label: "Prometheus" };
const ANSIBLE: EditorLang = { kind: "ansible", label: "Ansible" };
const K8S: EditorLang = { kind: "k8s", label: "Kubernetes" };

/** Editable file extensions (without the dot) → language. */
const EXT_LANG: Record<string, EditorLang> = {
  // Config / markup
  yaml: YAML,
  yml: YAML,
  json: JSON_,
  jsonc: JSON_,
  md: MD,
  markdown: MD,
  toml: TOML,
  conf: CONFIG,
  cfg: CONFIG,
  ini: CONFIG,
  env: CONFIG,
  properties: { kind: "ini", label: "Properties" },
  tf: TERRAFORM,
  tfvars: TERRAFORM,
  txt: TEXT,
  log: TEXT,
  // Shells
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  ksh: SHELL,
  ps1: POWERSHELL,
  psm1: POWERSHELL,
  psd1: POWERSHELL,
  // Scripts / languages
  py: PYTHON,
  pyw: PYTHON,
  js: JS,
  mjs: JS,
  cjs: JS,
  jsx: JS,
  ts: TS,
  tsx: TS,
  mts: TS,
  cts: TS,
  java: JAVA,
  dockerfile: DOCKER,
  go: GO,
  rs: RUST,
  rb: RUBY,
  c: C,
  h: C,
  cpp: CPP,
  cc: CPP,
  cxx: CPP,
  hpp: CPP,
  hh: CPP,
  cs: CSHARP,
  sql: SQL,
  lua: LUA,
  pl: PERL,
  pm: PERL,
  // Markup / web
  html: { kind: "html", label: "HTML" },
  htm: { kind: "html", label: "HTML" },
  css: { kind: "css", label: "CSS" },
  scss: { kind: "scss", label: "SCSS" },
  less: { kind: "less", label: "Less" },
  xml: { kind: "xml", label: "XML" },
  svg: { kind: "xml", label: "XML" },
  xsd: { kind: "xml", label: "XML" },
  xsl: { kind: "xml", label: "XML" },
  xslt: { kind: "xml", label: "XML" },
  plist: { kind: "xml", label: "XML" },
  // DevOps / config
  // systemd unit files are INI-shaped; each unit type maps to the systemd lint
  // (`systemd-analyze verify`). Detected by extension, unlike the name/path-keyed
  // daemon configs below (see daemonConfigLang).
  service: SYSTEMD,
  timer: SYSTEMD,
  socket: SYSTEMD,
  mount: SYSTEMD,
  automount: SYSTEMD,
  swap: SYSTEMD,
  target: SYSTEMD,
  path: SYSTEMD,
  slice: SYSTEMD,
  scope: SYSTEMD,
  proto: { kind: "protobuf", label: "Protobuf" },
  cmake: { kind: "cmake", label: "CMake" },
  diff: { kind: "diff", label: "Diff" },
  patch: { kind: "diff", label: "Diff" },
  http: { kind: "http", label: "HTTP" },
  pp: { kind: "puppet", label: "Puppet" },
  // More languages
  groovy: { kind: "groovy", label: "Groovy" },
  gradle: { kind: "groovy", label: "Gradle" },
  scala: { kind: "scala", label: "Scala" },
  sc: { kind: "scala", label: "Scala" },
  kt: { kind: "kotlin", label: "Kotlin" },
  kts: { kind: "kotlin", label: "Kotlin" },
  dart: { kind: "dart", label: "Dart" },
  swift: { kind: "swift", label: "Swift" },
  clj: { kind: "clojure", label: "Clojure" },
  cljs: { kind: "clojure", label: "Clojure" },
  cljc: { kind: "clojure", label: "Clojure" },
  edn: { kind: "clojure", label: "Clojure" },
  hs: { kind: "haskell", label: "Haskell" },
  erl: { kind: "erlang", label: "Erlang" },
  hrl: { kind: "erlang", label: "Erlang" },
  elm: { kind: "elm", label: "Elm" },
  cr: { kind: "crystal", label: "Crystal" },
  r: { kind: "r", label: "R" },
  jl: { kind: "julia", label: "Julia" },
  coffee: { kind: "coffeescript", label: "CoffeeScript" },
  vb: { kind: "vb", label: "Visual Basic" },
  scm: { kind: "scheme", label: "Scheme" },
  ss: { kind: "scheme", label: "Scheme" },
  lisp: { kind: "commonlisp", label: "Common Lisp" },
  cl: { kind: "commonlisp", label: "Common Lisp" },
  ml: { kind: "ocaml", label: "OCaml" },
  mli: { kind: "ocaml", label: "OCaml" },
  fs: { kind: "fsharp", label: "F#" },
  fsx: { kind: "fsharp", label: "F#" },
  fsi: { kind: "fsharp", label: "F#" },
  tcl: { kind: "tcl", label: "Tcl" },
  d: { kind: "d", label: "D" },
  v: { kind: "verilog", label: "Verilog" },
  sv: { kind: "verilog", label: "Verilog" },
  vhd: { kind: "vhdl", label: "VHDL" },
  vhdl: { kind: "vhdl", label: "VHDL" },
  pas: { kind: "pascal", label: "Pascal" },
  f90: { kind: "fortran", label: "Fortran" },
  f95: { kind: "fortran", label: "Fortran" },
  f03: { kind: "fortran", label: "Fortran" },
  cob: { kind: "cobol", label: "COBOL" },
  cbl: { kind: "cobol", label: "COBOL" },
};

/** Well-known extensionless / dotfile config names (lower-cased basename). */
const NAME_LANG: Record<string, EditorLang> = {
  ".env": CONFIG,
  ".bashrc": SHELL,
  ".zshrc": SHELL,
  ".profile": SHELL,
  ".bash_profile": SHELL,
  ".gitignore": TEXT,
  ".gitconfig": CONFIG,
  dockerfile: DOCKER,
  containerfile: DOCKER,
  makefile: TEXT,
  gemfile: RUBY,
  rakefile: RUBY,
  vagrantfile: RUBY,
  "nginx.conf": NGINX,
  "cmakelists.txt": { kind: "cmake", label: "CMake" },
  "build.gradle": { kind: "groovy", label: "Gradle" },
};

/** Basename of a slash-separated path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Lower-case extension (without dot), or `""` when the name has none. A leading
 * dot is treated as a hidden-file marker, not an extension (`.env` → `""`), so
 * such files are matched by {@link NAME_LANG} instead.
 */
export function fileExt(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * True when a path lies inside an nginx config tree — any path segment equal to
 * `nginx` (e.g. `/etc/nginx/conf.d/app.conf`, `/etc/nginx/sites-available/site`).
 * Custom nginx configs have no distinguishing name or extension, so we key on the
 * directory. Keyed on the `nginx` segment specifically so apache's identically named
 * `conf.d`/`sites-available` dirs (under `apache2/`/`httpd/`) don't false-match.
 */
export function isNginxConfigPath(path: string): boolean {
  return path.split(/[/\\]/).some((seg) => seg.toLowerCase() === "nginx");
}

/** Lower-cased path segments (handles both `/` and `\` separators). */
function pathSegments(path: string): string[] {
  return path.split(/[/\\]/).map((s) => s.toLowerCase());
}

/**
 * Daemon config files recognised by name/directory (Phase A) — each enables a
 * server-side validator run over SSH (`sshd -t`, `visudo -c`, `haproxy -c`,
 * `named-checkconf`). Like {@link isNginxConfigPath}, these have no distinguishing
 * extension, so we key on the canonical basename or the config directory. systemd
 * units are keyed on their extension instead (see `EXT_LANG`), so they're not here.
 */
function daemonConfigLang(path: string): EditorLang | null {
  const base = baseName(path).toLowerCase();
  const segs = pathSegments(path);
  const ext = fileExt(path);
  // OpenSSH server: /etc/ssh/sshd_config and drop-ins under sshd_config.d/.
  if (base === "sshd_config") return SSHD;
  if (segs.includes("sshd_config.d") && (ext === "conf" || ext === "")) return SSHD;
  // sudo: /etc/sudoers and drop-ins under sudoers.d/ (the latter are extensionless).
  if (base === "sudoers") return SUDOERS;
  if (segs.includes("sudoers.d")) return SUDOERS;
  // HAProxy: haproxy.cfg, or any .cfg/.conf under a haproxy/ tree.
  if (base === "haproxy.cfg") return HAPROXY;
  if (segs.includes("haproxy") && (ext === "cfg" || ext === "conf")) return HAPROXY;
  // BIND: named.conf and its includes (named.conf.local, named.conf.options).
  if (base === "named.conf" || base.startsWith("named.conf.")) return BIND;
  return null;
}

/** True for a `.yml`/`.yaml` file. */
function isYamlExt(ext: string): boolean {
  return ext === "yml" || ext === "yaml";
}

/**
 * A YAML file whose name/directory identifies a specific dialect with its own
 * validator (Phase B): docker-compose, GitHub Actions workflows, Prometheus, and
 * Ansible playbooks/roles. Kubernetes manifests have no naming convention, so they're
 * detected from content instead (see {@link yamlDialectFromContent}). Returns `null`
 * for a plain YAML file (→ yamllint).
 */
function yamlToolLang(path: string): EditorLang | null {
  const base = baseName(path).toLowerCase();
  const ext = fileExt(path);
  if (!isYamlExt(ext)) return null;
  const segs = pathSegments(path);
  const stem = base.slice(0, base.length - ext.length - 1); // drop `.yml`/`.yaml`
  // docker compose: compose.yml / docker-compose.yml / docker-compose.<env>.yml.
  if (stem === "compose" || stem === "docker-compose" || stem.startsWith("docker-compose.")) {
    return COMPOSE;
  }
  // GitHub Actions: any workflow under .github/workflows/.
  if (segs.includes(".github") && segs.includes("workflows")) return GHACTIONS;
  // Prometheus main config (rule files are deferred — they need `promtool check rules`).
  if (stem === "prometheus") return PROMETHEUS;
  // Ansible: playbooks (playbook.yml/site.yml) or files under a role/playbooks tree.
  const ansibleDir = ["playbooks", "tasks", "handlers", "meta", "defaults"];
  if (
    stem === "playbook" ||
    stem === "site" ||
    (segs.includes("roles") && segs.some((s) => ansibleDir.includes(s))) ||
    segs.includes("playbooks")
  ) {
    return ANSIBLE;
  }
  return null;
}

/**
 * The YAML dialect inferred from a buffer's content (Phase B), for files with no
 * distinguishing name: Kubernetes manifests (`apiVersion:` + `kind:` at the top
 * level) and Ansible playbooks (`hosts:` plays). Returns `null` for plain YAML.
 */
export function yamlDialectFromContent(content: string): EditorLang | null {
  // Only scan the head — enough to see the top-level keys without cost on big files.
  const head = content.slice(0, 4000);
  if (/^apiVersion:\s*\S/m.test(head) && /^kind:\s*\S/m.test(head)) return K8S;
  if (/^\s*-?\s*hosts:\s*\S/m.test(head) && /^\s{2,}(tasks|roles|handlers):/m.test(head)) {
    return ANSIBLE;
  }
  return null;
}

/**
 * Upgrade a plain-YAML language to a content-detected dialect (k8s/Ansible) once the
 * buffer is available. A no-op unless `lang` is generic `yaml` — a name/path match
 * (compose, workflows, prometheus) is more specific and always wins.
 */
export function editorLangWithDialect(lang: EditorLang, content: string): EditorLang {
  if (lang.kind !== "yaml") return lang;
  return yamlDialectFromContent(content) ?? lang;
}

/**
 * The editor language for a file, or `null` when vterm should not open it in the
 * in-app editor (unknown type → leave the existing download behaviour). Pass a full
 * path when available: custom nginx configs are recognised by their directory
 * ({@link isNginxConfigPath}), not just `nginx.conf` by name.
 */
export function editorLangFor(name: string): EditorLang | null {
  const byName = NAME_LANG[baseName(name).toLowerCase()];
  if (byName) return byName;
  const daemon = daemonConfigLang(name);
  if (daemon) return daemon;
  const yamlTool = yamlToolLang(name);
  if (yamlTool) return yamlTool;
  const ext = fileExt(name);
  // Custom nginx configs (conf.d/*.conf, sites-available/enabled, snippets, params
  // includes) — `.conf` or extensionless files under an `nginx/` tree — map to nginx
  // for highlighting + the `nginx -t` lint badge, rather than the generic Config(ini).
  if ((ext === "conf" || ext === "") && isNginxConfigPath(name)) return NGINX;
  return EXT_LANG[ext] ?? null;
}

/** True when a file has a recognised editor language (used for hints, not gating). */
export function isEditable(name: string): boolean {
  return editorLangFor(name) !== null;
}

/**
 * The editor language for a file, always resolved — falling back to plain text for
 * unknown/extensionless files. Any file can be opened in the editor (binary/oversize
 * files are still rejected by the backend read guard, not here).
 */
export function editorLangOrPlain(name: string): EditorLang {
  return editorLangFor(name) ?? TEXT;
}

/**
 * Whether a file is worth verifying against the server's set of nginx-loaded configs
 * (`nginx -T`): only `.conf` and extensionless files — nginx `include` targets are
 * almost always one of these. Gates the round-trip so ordinary files (`.py`/`.md`/…)
 * never trigger it.
 */
export function couldBeNginxInclude(path: string): boolean {
  const ext = fileExt(path);
  return ext === "conf" || ext === "";
}

/**
 * The editor language for a file, upgraded to nginx when the server reports the path
 * among the configs nginx actually loads (from `nginx -T`) — catching includes that
 * live outside the `/etc/nginx/` tree, which the path heuristic can't see. A `null`
 * set means "not fetched", so detection stays purely path-based.
 */
export function editorLangWithIncludes(
  path: string,
  nginxConfigs: ReadonlySet<string> | null,
): EditorLang {
  const lang = editorLangOrPlain(path);
  if (lang.kind !== "nginx" && nginxConfigs?.has(path)) return NGINX;
  return lang;
}
