// Jinja2 over the language underneath (ADR 0076): `{{ expr }}`, `{% tag %}`,
// `{# comment #}` in Ansible YAML, in `*.j2` templates and in Helm's
// `templates/` (Go templates share the delimiters). Not a grammar — a layer of
// marks over whatever highlights the file, so a template keeps its YAML or
// nginx colours and its expressions stand apart.

import { RangeSetBuilder, type Extension, type Text } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { EditorLang } from "./editorlang";

export interface JinjaSpan {
  from: number;
  to: number;
  kind: "expr" | "tag" | "comment";
}

const OPEN: Record<string, { close: string; kind: JinjaSpan["kind"] }> = {
  "{{": { close: "}}", kind: "expr" },
  "{%": { close: "%}", kind: "tag" },
  "{#": { close: "#}", kind: "comment" },
};

/** How far a construct may run before it is taken for a stray `{{`. */
const MAX_SPAN = 4000;

/** The template constructs in `text`, offset by `base`; an unclosed one runs to the end. */
export function jinjaSpans(text: string, base = 0): JinjaSpan[] {
  const out: JinjaSpan[] = [];
  let i = 0;
  while (i < text.length - 1) {
    const at = text.indexOf("{", i);
    if (at < 0 || at >= text.length - 1) break;
    const open = OPEN[text.slice(at, at + 2)];
    if (!open) {
      i = at + 1;
      continue;
    }
    const end = text.indexOf(open.close, at + 2);
    if (end < 0 || end - at > MAX_SPAN) {
      i = at + 2;
      continue;
    }
    out.push({ from: base + at, to: base + end + 2, kind: open.kind });
    i = end + 2;
  }
  return out;
}

/** Whether a file of `lang` at `path` carries Jinja (or Go template) constructs. */
export function hasTemplates(lang: EditorLang, path: string): boolean {
  if (lang.jinja) return true;
  if (lang.kind === "ansible") return true;
  // A Helm chart's templates: YAML under `templates/`.
  const yamlish = ["yaml", "k8s", "compose"].includes(lang.kind);
  return yamlish && /(^|[/\\])templates[/\\]/.test(path);
}

const body = { expr: Decoration.mark({ class: "cm-jinja" }), tag: Decoration.mark({ class: "cm-jinja" }), comment: Decoration.mark({ class: "cm-jinja-comment" }) };
const delim = Decoration.mark({ class: "cm-jinja-delim" });

/** Read a little before the viewport, so a construct that starts above it is seen whole. */
const LOOKBACK = 600;

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc: Text = view.state.doc;
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    const start = Math.max(last, from - LOOKBACK);
    const text = doc.sliceString(start, Math.min(doc.length, to + LOOKBACK));
    for (const s of jinjaSpans(text, start)) {
      if (s.to <= from || s.from < last) continue;
      if (s.kind === "comment") {
        b.add(s.from, s.to, body.comment);
      } else {
        b.add(s.from, s.from + 2, delim);
        if (s.to - 2 > s.from + 2) b.add(s.from + 2, s.to - 2, body[s.kind]);
        b.add(s.to - 2, s.to, delim);
      }
      last = s.to;
    }
  }
  return b.finish();
}

/** The marks; the colours are the editor theme's (`cmtheme.ts`). */
export function jinjaLayer(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
