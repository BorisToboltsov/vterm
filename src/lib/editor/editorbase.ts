// The editor's working set beyond highlighting (ADR 0076): folding, several
// cursors, brackets that close, completion from the document and the
// language's snippets, indentation that follows the file, guides for it, the
// trailing spaces it would carry to the server. CodeMirror's own modules — this
// file only wires them and gives what they draw the theme's tokens. Visible
// words come in through `EditorWords`: a pure module calls no `t()`.

import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  crosshairCursor,
  highlightTrailingWhitespace,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { codeFolding, foldGutter, foldService, getIndentUnit, indentUnit } from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  completeAnyWord,
  snippetCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { ICONS } from "../ui/icons";
import { indentString, type IndentInfo } from "./indent";
import type { EditorLangKind } from "./editorlang";

/** Words the extensions draw, from the caller's `t()`. */
export interface EditorWords {
  /** The folded block's pill: how many lines it hides. */
  folded: (lines: number) => string;
  fold: string;
  unfold: string;
  /** The detail of a snippet in the completion list. */
  snippet: string;
}

/** Kinds whose grammar folds by its tree; the rest fold by indentation. */
const TREE_FOLDS: ReadonlySet<EditorLangKind> = new Set<EditorLangKind>([
  "json",
  "yaml",
  "compose",
  "ghactions",
  "prometheus",
  "ansible",
  "k8s",
  "markdown",
  "python",
  "javascript",
  "typescript",
  "java",
  "go",
  "rust",
  "c",
  "cpp",
  "sql",
  "html",
  "css",
  "scss",
  "less",
  "xml",
]);

/** Whether `kind` folds by indentation (no grammar tree to fold by). */
export function foldsByIndent(kind: EditorLangKind): boolean {
  return !TREE_FOLDS.has(kind);
}

/** Columns of leading whitespace, a tab advancing to the next stop. */
export function leadColumns(line: string, tabSize: number): { cols: number; chars: number } {
  let cols = 0;
  let chars = 0;
  for (const c of line) {
    if (c === " ") cols++;
    else if (c === "\t") cols += tabSize - (cols % tabSize);
    else break;
    chars++;
  }
  return { cols, chars };
}

/**
 * The block an indented region folds to: from the end of `lineNo` to the end of
 * the last following line indented deeper (blank lines inside count, trailing
 * blank lines do not). Null when the next non-blank line is not deeper.
 */
export function indentFoldRange(
  lines: readonly string[],
  lineNo: number,
  tabSize: number,
): { endLine: number } | null {
  const first = lines[lineNo - 1];
  if (first === undefined || first.trim() === "") return null;
  const base = leadColumns(first, tabSize).cols;
  let end = -1;
  for (let i = lineNo; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (leadColumns(l, tabSize).cols <= base) break;
    end = i + 1;
  }
  return end > lineNo ? { endLine: end } : null;
}

const foldByIndent = foldService.of((state, from) => {
  const line = state.doc.lineAt(from);
  const tab = state.tabSize;
  const base = leadColumns(line.text, tab).cols;
  if (line.text.trim() === "") return null;
  let end = -1;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (l.text.trim() === "") continue;
    if (leadColumns(l.text, tab).cols <= base) break;
    end = n;
    if (n - line.number > 20000) break;
  }
  return end > line.number ? { from: line.to, to: state.doc.line(end).to } : null;
});

function svgIcon(name: keyof typeof ICONS, size: number): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

/** The fold gutter and the folded block's pill. */
export function folding(words: EditorWords, byIndent: boolean): Extension {
  return [
    ...(byIndent ? [foldByIndent] : []),
    codeFolding({
      preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
      placeholderDOM: (_view, onclick, lines: number) => {
        const el = document.createElement("span");
        el.className = "cm-foldPlaceholder";
        el.textContent = words.folded(lines);
        el.title = words.unfold;
        el.setAttribute("aria-label", words.unfold);
        el.onclick = onclick;
        return el;
      },
    }),
    foldGutter({
      markerDOM: (open) => {
        const el = document.createElement("span");
        el.className = "cm-foldMarker";
        el.title = open ? words.fold : words.unfold;
        el.innerHTML = svgIcon(open ? "chevronDown" : "chevronRight", 12);
        return el;
      },
    }),
  ];
}

/** Several cursors (`⌘D`, `⌥`-drag a column) — off until v1.37: `⌘D` did nothing. */
export function multiCursor(): Extension {
  return [EditorState.allowMultipleSelections.of(true), rectangularSelection(), crosshairCursor()];
}

/** Brackets and quotes that close themselves. */
export function brackets(on: boolean): Extension {
  return on ? closeBrackets() : [];
}

/** Snippets of the file's language as completions (a `${1:x}` template each). */
export function snippetSource(snippets: readonly { name: string; body: string }[], detail: string): CompletionSource {
  const options: Completion[] = snippets.map((s) =>
    snippetCompletion(s.body.replace(/\$(?!\{|\d)/g, "\\$"), { label: s.name, detail, type: "text", boost: -1 }),
  );
  return (ctx) => {
    const word = ctx.matchBefore(/[\w-]+$/);
    if (!word && !ctx.explicit) return null;
    return { from: word ? word.from : ctx.pos, options, validFor: /^[\w-]*$/ };
  };
}

/**
 * Completion from the document's own words and the language's snippets. Given
 * through the language data, so a language server's completion (when one runs)
 * joins the same list instead of replacing it.
 */
export function completion(on: boolean, snippets: readonly { name: string; body: string }[], words: EditorWords): Extension {
  if (!on) return [];
  const sources: CompletionSource[] = [completeAnyWord];
  if (snippets.length > 0) sources.push(snippetSource(snippets, words.snippet));
  return [
    autocompletion({ activateOnTypingDelay: 120, maxRenderedOptions: 60 }),
    EditorState.languageData.of(() => sources.map((s) => ({ autocomplete: s }))),
  ];
}

/** The unit Tab, Enter and the guides use, and the width a tab is shown with. */
export function indentation(info: IndentInfo): Extension {
  return [indentUnit.of(indentString(info)), EditorState.tabSize.of(info.tabs ? info.width : Math.max(info.width, 4))];
}

const guideMarks = new Map<number, Decoration>();
function guideMark(unit: number): Decoration {
  const w = Math.min(Math.max(unit, 1), 8);
  let d = guideMarks.get(w);
  if (!d) {
    d = Decoration.mark({ class: `cm-indent-guide cm-indent-guide-${w}` });
    guideMarks.set(w, d);
  }
  return d;
}

function guides(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const unitStr = view.state.facet(indentUnit);
  const tab = view.state.tabSize;
  // Columns per level: a tab unit is one tab stop wide.
  const unit = unitStr === "\t" ? tab : getIndentUnit(view.state);
  // A tab-indented line is drawn per tab, so the stripes need the tab width.
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const { cols, chars } = leadColumns(line.text, tab);
      if (chars > 0 && cols >= unit && line.text.trim() !== "") {
        b.add(line.from, line.from + chars, guideMark(line.text[0] === "\t" ? 1 : unit));
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

/** Thin guides at each level of indentation (as wide as the unit; a tab — one per tab). */
export function indentGuides(on: boolean): Extension {
  if (!on) return [];
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = guides(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.startState.facet(indentUnit) !== u.state.facet(indentUnit)) {
          this.decorations = guides(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** The trailing spaces a save would carry, tinted. */
export function trailingSpace(on: boolean): Extension {
  return on ? highlightTrailingWhitespace() : [];
}

/** Lines that wrap at the edge, or scroll sideways. */
export function wrapping(on: boolean): Extension {
  return on ? EditorView.lineWrapping : [];
}

/**
 * How the parts above look: the theme's tokens only (the design is frozen —
 * DESIGN.md). Guide stripes are classes per unit, not a style attribute: the
 * packaged build's CSP would drop an inline style.
 */
export const baseTheme: Extension = EditorView.theme({
  ".cm-foldGutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", width: "1rem" },
  ".cm-foldMarker": { display: "inline-flex", color: "var(--color-muted)", cursor: "pointer", opacity: "0.7" },
  ".cm-foldMarker:hover": { color: "var(--color-accent)", opacity: "1" },
  ".cm-foldPlaceholder": {
    display: "inline-block",
    margin: "0 0.25rem",
    padding: "0 0.35rem",
    border: "1px solid var(--color-edge)",
    borderRadius: "4px",
    color: "var(--color-muted)",
    background: "transparent",
    fontSize: "0.85em",
    cursor: "pointer",
  },
  ".cm-foldPlaceholder:hover": { color: "var(--color-accent)", borderColor: "var(--color-accent)" },
  ".cm-trailingSpace": { backgroundColor: "color-mix(in srgb, var(--color-bad) 28%, transparent)" },
  ".cm-indent-guide": {
    backgroundImage: "linear-gradient(to right, color-mix(in srgb, var(--color-muted) 22%, transparent) 1px, transparent 1px)",
    backgroundRepeat: "repeat-x",
  },
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8].map((w) => [`.cm-indent-guide-${w}`, { backgroundSize: `${w}ch 100%` }]),
  ),
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--color-edge)",
    background: "var(--color-panel-alt)",
    borderRadius: "6px",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 8px", color: "var(--color-text)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "color-mix(in srgb, var(--color-accent) 22%, transparent)",
    color: "var(--color-text)",
  },
  ".cm-completionDetail": { color: "var(--color-muted)", fontStyle: "normal", marginLeft: "0.75em" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--color-accent)" },
  ".cm-tooltip.cm-completionInfo": {
    border: "1px solid var(--color-edge)",
    background: "var(--color-panel-alt)",
    color: "var(--color-text)",
    maxWidth: "26rem",
    padding: "6px 8px",
    borderRadius: "6px",
  },
  ".cm-tooltip": { border: "1px solid var(--color-edge)", background: "var(--color-panel-alt)", color: "var(--color-text)" },
  ".cm-tooltip-hover": { padding: "6px 8px", maxWidth: "36rem", borderRadius: "6px" },
});
