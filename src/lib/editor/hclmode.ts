// HCL — Terraform's language — as a CodeMirror stream mode (ADR 0071). No
// package of the CodeMirror project covers it, and a third-party grammar would
// be a dependency for one file type; this is small and ours: block keywords,
// attribute names, strings with `${…}` / `%{…}` templates, heredocs, numbers,
// `true/false/null`, references (`var.`, `local.`, `module.`, `data.`), and the
// three comment forms. Highlighting only — Terraform's own checks are
// `terraform validate` in the terminal.
import type { StreamParser, StringStream } from "@codemirror/language";

interface HclState {
  /** Inside a `/* … *\/` comment. */
  comment: boolean;
  /** Inside a string: the template depth, or null. */
  string: boolean;
  templateDepth: number;
  /** Inside a heredoc: its end marker. */
  heredoc: string | null;
  /** The token before was a block's name: the next words are its labels. */
  labels: boolean;
}

const BLOCKS = new Set([
  "resource",
  "data",
  "module",
  "variable",
  "output",
  "locals",
  "provider",
  "terraform",
  "backend",
  "required_providers",
  "lifecycle",
  "dynamic",
  "provisioner",
  "connection",
  "moved",
  "import",
  "check",
  "removed",
]);
const KEYWORDS = new Set(["for", "in", "if", "else", "endif", "endfor"]);
const ATOMS = new Set(["true", "false", "null"]);
const REFS = new Set(["var", "local", "module", "data", "each", "count", "path", "self", "terraform"]);

function inString(stream: StringStream, state: HclState): string {
  while (!stream.eol()) {
    // A template: the text before it is one token, `${` the next.
    if (stream.match(/^[$%]\{/, false)) {
      if (stream.pos > stream.start) return "string";
      stream.next();
      stream.next();
      state.templateDepth++;
      state.string = false;
      return "meta";
    }
    const ch = stream.next();
    if (ch === "\\") {
      stream.next();
      continue;
    }
    if (ch === '"') {
      state.string = false;
      return "string";
    }
  }
  return "string";
}

export const hcl: StreamParser<HclState> = {
  name: "hcl",
  startState: () => ({ comment: false, string: false, templateDepth: 0, heredoc: null, labels: false }),
  token(stream, state) {
    if (state.heredoc !== null) {
      if (stream.sol() && stream.match(new RegExp(`^\\s*${state.heredoc}\\s*$`))) {
        state.heredoc = null;
        return "string";
      }
      stream.skipToEnd();
      return "string";
    }
    if (state.comment) {
      if (stream.match(/^.*?\*\//)) state.comment = false;
      else stream.skipToEnd();
      return "comment";
    }
    if (state.string) return inString(stream, state);
    if (stream.eatSpace()) return null;

    if (stream.match("#") || stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.comment = true;
      return "comment";
    }
    const heredoc = stream.match(/^<<-?([A-Za-z_][A-Za-z0-9_]*)/) as RegExpMatchArray | null;
    if (heredoc) {
      state.heredoc = heredoc[1];
      return "string";
    }
    if (stream.peek() === '"') {
      stream.next();
      state.string = true;
      const style = inString(stream, state);
      if (state.labels && !state.string) return "typeName";
      return style;
    }
    if (state.templateDepth > 0 && stream.peek() === "}") {
      stream.next();
      state.templateDepth--;
      state.string = true;
      return "meta";
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][-+]?\d+)?/)) return "number";
    const word = stream.match(/^[A-Za-z_][A-Za-z0-9_-]*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      const startOfLine = stream.string.slice(0, stream.start).trim() === "";
      if (startOfLine && BLOCKS.has(w)) {
        state.labels = true;
        return "keyword";
      }
      if (state.labels) return "typeName";
      if (ATOMS.has(w)) return "atom";
      if (KEYWORDS.has(w)) return "keyword";
      if (REFS.has(w) && stream.peek() === ".") return "variableName.special";
      if (startOfLine && /^\s*=(?!=)/.test(stream.string.slice(stream.pos))) return "propertyName";
      if (stream.peek() === "(") return "function";
      return "variableName";
    }
    const ch = stream.next();
    if (ch === "{" || ch === "}") state.labels = false;
    if (ch === "=" || ch === "?" || ch === ":" || ch === "!" || ch === "<" || ch === ">" || ch === "&" || ch === "|") return "operator";
    return null;
  },
  blankLine(state) {
    state.labels = false;
  },
  languageData: { commentTokens: { line: "#", block: { open: "/*", close: "*/" } } },
};
