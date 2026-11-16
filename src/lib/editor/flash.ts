// The lines a format just changed, lit for a moment (ADR 0076): the eye finds
// what moved without a diff. A state field of line marks; the caller clears it
// after `FLASH_MS` with `flashLines(null)`.

import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export const FLASH_MS = 1600;

/** Set the lit lines (1-based), or clear them with null. */
export const flashLines = StateEffect.define<number[] | null>();

const mark = Decoration.line({ class: "cm-format-flash" });

/** The 1-based lines of `next` that are not where they were in `prev` (head and tail kept). */
export function changedLineNumbers(prev: string, next: string): number[] {
  const a = prev.split("\n");
  const b = next.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const out: number[] = [];
  const kept = new Set(a.slice(s, a.length - e));
  for (let i = s; i < b.length - e; i++) if (!kept.has(b[i])) out.push(i + 1);
  return out;
}

function build(doc: Text, lines: readonly number[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const n of [...lines].sort((x, y) => x - y)) {
    if (n >= 1 && n <= doc.lines) {
      const l = doc.line(n);
      b.add(l.from, l.from, mark);
    }
  }
  return b.finish();
}

/** The field and its look (the theme's accent, faint). */
export function changeFlash(): Extension {
  return [
    StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update(deco, tr) {
        let next = deco.map(tr.changes);
        for (const e of tr.effects) if (e.is(flashLines)) next = e.value ? build(tr.state.doc, e.value) : Decoration.none;
        return next;
      },
      provide: (f) => EditorView.decorations.from(f),
    }),
    EditorView.theme({
      ".cm-format-flash": { backgroundColor: "color-mix(in srgb, var(--color-accent) 14%, transparent)" },
    }),
  ];
}
