// Pure mapping: a remote filename → the editor language used for CodeMirror
// highlighting, and whether vterm opens it in the in-app editor on click.
// Extension-based with a few well-known extensionless/dotfile config names;
// anything editable but unrecognised falls back to plain text.
//
// Language labels are short technical strings (YAML/JSON/TOML/…) and are NOT
// translated — same rule as log-format badges and theme/font names (see the
// i18n section of CONTEXT.md).

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
  "nginx.conf": { kind: "nginx", label: "nginx" },
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
 * The editor language for a file, or `null` when vterm should not open it in the
 * in-app editor (unknown type → leave the existing download behaviour).
 */
export function editorLangFor(name: string): EditorLang | null {
  const byName = NAME_LANG[baseName(name).toLowerCase()];
  if (byName) return byName;
  return EXT_LANG[fileExt(name)] ?? null;
}

/** True when double-clicking the file opens the in-app editor. */
export function isEditable(name: string): boolean {
  return editorLangFor(name) !== null;
}
