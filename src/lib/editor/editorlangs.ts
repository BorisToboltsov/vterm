// CodeMirror language support for the editor, loaded the first time a file of
// that language is opened (v1.25.2). The grammars — @lezer/* and the legacy
// StreamLanguage modes — were ~650 KB of the page's single script chunk, parsed
// at every launch for languages most sessions never open; each `import()` here
// becomes a chunk of its own. Which kind a file is stays in editorlang.ts.
//
// JSON stays a static import: the editor's JSON linter (`jsonParseLinter`) needs
// the same package anyway.

import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import type { EditorLangKind } from "./editorlang";

const legacy = <T>(parser: StreamParser<T>): Extension => StreamLanguage.define(parser);

/** Highlighting for `kind`; an empty extension for plain text. */
export async function loadLanguage(kind: EditorLangKind): Promise<Extension> {
  switch (kind) {
    case "json":
      return json();
    case "yaml":
    // YAML-family dialects are highlighted as YAML; only their server validator
    // differs (docker compose config / actionlint / kubeconform / …).
    case "compose":
    case "ghactions":
    case "prometheus":
    case "ansible":
    case "k8s":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "c":
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "scss":
      return (await import("@codemirror/lang-sass")).sass({ indented: false });
    case "less":
      return (await import("@codemirror/lang-less")).less();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "shell":
      return legacy((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "toml":
      return legacy((await import("@codemirror/legacy-modes/mode/toml")).toml);
    // Daemon configs: approximate highlighting — systemd units and the key/value
    // daemon configs are INI-shaped; BIND's braces/semicolons fit nginx.
    case "ini":
    case "systemd":
    case "sshdconfig":
    case "sudoers":
    case "haproxy":
      return legacy((await import("@codemirror/legacy-modes/mode/properties")).properties);
    case "nginx":
    case "bind":
      return legacy((await import("./nginxmode")).nginx);
    case "dockerfile":
      return legacy((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
    case "ruby":
      return legacy((await import("@codemirror/legacy-modes/mode/ruby")).ruby);
    case "csharp":
      return legacy((await import("@codemirror/legacy-modes/mode/clike")).csharp);
    case "scala":
      return legacy((await import("@codemirror/legacy-modes/mode/clike")).scala);
    case "kotlin":
      return legacy((await import("@codemirror/legacy-modes/mode/clike")).kotlin);
    case "dart":
      return legacy((await import("@codemirror/legacy-modes/mode/clike")).dart);
    case "powershell":
      return legacy((await import("@codemirror/legacy-modes/mode/powershell")).powerShell);
    case "lua":
      return legacy((await import("@codemirror/legacy-modes/mode/lua")).lua);
    case "perl":
      return legacy((await import("@codemirror/legacy-modes/mode/perl")).perl);
    case "cmake":
      return legacy((await import("@codemirror/legacy-modes/mode/cmake")).cmake);
    case "diff":
      return legacy((await import("@codemirror/legacy-modes/mode/diff")).diff);
    case "http":
      return legacy((await import("@codemirror/legacy-modes/mode/http")).http);
    case "protobuf":
      return legacy((await import("@codemirror/legacy-modes/mode/protobuf")).protobuf);
    case "puppet":
      return legacy((await import("@codemirror/legacy-modes/mode/puppet")).puppet);
    case "groovy":
      return legacy((await import("@codemirror/legacy-modes/mode/groovy")).groovy);
    case "swift":
      return legacy((await import("@codemirror/legacy-modes/mode/swift")).swift);
    case "clojure":
      return legacy((await import("@codemirror/legacy-modes/mode/clojure")).clojure);
    case "haskell":
      return legacy((await import("@codemirror/legacy-modes/mode/haskell")).haskell);
    case "erlang":
      return legacy((await import("@codemirror/legacy-modes/mode/erlang")).erlang);
    case "elm":
      return legacy((await import("@codemirror/legacy-modes/mode/elm")).elm);
    case "crystal":
      return legacy((await import("@codemirror/legacy-modes/mode/crystal")).crystal);
    case "r":
      return legacy((await import("@codemirror/legacy-modes/mode/r")).r);
    case "julia":
      return legacy((await import("@codemirror/legacy-modes/mode/julia")).julia);
    case "coffeescript":
      return legacy((await import("@codemirror/legacy-modes/mode/coffeescript")).coffeeScript);
    case "vb":
      return legacy((await import("@codemirror/legacy-modes/mode/vb")).vb);
    case "scheme":
      return legacy((await import("@codemirror/legacy-modes/mode/scheme")).scheme);
    case "commonlisp":
      return legacy((await import("@codemirror/legacy-modes/mode/commonlisp")).commonLisp);
    case "ocaml":
      return legacy((await import("@codemirror/legacy-modes/mode/mllike")).oCaml);
    case "fsharp":
      return legacy((await import("@codemirror/legacy-modes/mode/mllike")).fSharp);
    case "tcl":
      return legacy((await import("@codemirror/legacy-modes/mode/tcl")).tcl);
    case "d":
      return legacy((await import("@codemirror/legacy-modes/mode/d")).d);
    case "verilog":
      return legacy((await import("@codemirror/legacy-modes/mode/verilog")).verilog);
    case "vhdl":
      return legacy((await import("@codemirror/legacy-modes/mode/vhdl")).vhdl);
    case "pascal":
      return legacy((await import("@codemirror/legacy-modes/mode/pascal")).pascal);
    case "fortran":
      return legacy((await import("@codemirror/legacy-modes/mode/fortran")).fortran);
    case "cobol":
      return legacy((await import("@codemirror/legacy-modes/mode/cobol")).cobol);
    case "plain":
      return [];
    default: {
      // A kind added to EditorLangKind without a grammar here fails to compile.
      const unhandled: never = kind;
      return unhandled;
    }
  }
}
