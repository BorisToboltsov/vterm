import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { language } from "@codemirror/language";
import { loadLanguage } from "./editorlangs";
import type { EditorLangKind } from "./editorlang";

// Every kind editorlang.ts can name. Kept as a literal list so a new kind shows
// up here in review; the switch in editorlangs.ts is exhaustive over the type.
const KINDS: EditorLangKind[] = [
  "yaml", "json", "markdown", "shell", "toml", "ini", "python", "javascript", "typescript",
  "java", "dockerfile", "go", "rust", "ruby", "c", "cpp", "csharp", "sql", "powershell",
  "lua", "perl", "html", "css", "scss", "less", "xml", "nginx", "sshdconfig", "sudoers",
  "haproxy", "bind", "systemd", "compose", "ghactions", "prometheus", "ansible", "k8s",
  "cmake", "diff", "http", "protobuf", "puppet", "groovy", "scala", "kotlin", "dart", "swift",
  "clojure", "haskell", "erlang", "elm", "crystal", "r", "julia", "coffeescript", "vb",
  "scheme", "commonlisp", "ocaml", "fsharp", "tcl", "d", "verilog", "vhdl", "pascal",
  "fortran", "cobol",
];

/** The language a state configured with `ext` ends up with, by name. */
function languageName(ext: Awaited<ReturnType<typeof loadLanguage>>): string | null {
  const state = EditorState.create({ doc: "x", extensions: ext });
  return state.facet(language)?.name ?? null;
}

describe("loadLanguage", () => {
  it.each(KINDS)("gives %s a grammar", async (kind) => {
    expect(languageName(await loadLanguage(kind))).not.toBeNull();
  });

  it("gives plain text none", async () => {
    expect(languageName(await loadLanguage("plain"))).toBeNull();
  });

  it("highlights the YAML dialects as YAML and daemon configs as INI / nginx", async () => {
    const yaml = languageName(await loadLanguage("yaml"));
    for (const kind of ["compose", "ghactions", "prometheus", "ansible", "k8s"] as const) {
      expect(languageName(await loadLanguage(kind))).toBe(yaml);
    }
    const ini = languageName(await loadLanguage("ini"));
    for (const kind of ["systemd", "sshdconfig", "sudoers", "haproxy"] as const) {
      expect(languageName(await loadLanguage(kind))).toBe(ini);
    }
    expect(languageName(await loadLanguage("bind"))).toBe(languageName(await loadLanguage("nginx")));
  });
});

// The grammars stay out of the startup script only while nobody imports one
// statically: a single `import { python } from "@codemirror/lang-python"` in a
// component would pull it back into the page's chunk, with no test noticing.

/** Static imports of a grammar package (JSON excepted — its linter needs it). */
function staticGrammarImports(src: string): string[] {
  return [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)]
    .map((m) => m[1])
    .filter(
      (spec) =>
        (spec.startsWith("@codemirror/lang-") && spec !== "@codemirror/lang-json") ||
        spec.startsWith("@codemirror/legacy-modes") ||
        /(^|\/)nginxmode$/.test(spec),
    );
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("grammars load on demand", () => {
  it("no source imports a grammar statically", () => {
    const src = join(process.cwd(), "src");
    const offenders = sources(src).flatMap((f) =>
      staticGrammarImports(readFileSync(f, "utf8")).map((spec) => `${relative(src, f)}: ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("catches its own violations", () => {
    expect(staticGrammarImports('  import { python } from "@codemirror/lang-python";')).toEqual([
      "@codemirror/lang-python",
    ]);
    expect(staticGrammarImports('import { shell } from "@codemirror/legacy-modes/mode/shell";')).toHaveLength(1);
    expect(staticGrammarImports('import { nginx } from "./nginxmode";')).toHaveLength(1);
    expect(staticGrammarImports('import { jsonParseLinter } from "@codemirror/lang-json";')).toEqual([]);
    expect(staticGrammarImports('return (await import("@codemirror/lang-go")).go();')).toEqual([]);
  });
});
