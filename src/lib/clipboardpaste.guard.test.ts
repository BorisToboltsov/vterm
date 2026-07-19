// Paste guard (Phase 39.6): never derive a caret position from the raw length of
// pasted clipboard text.
//
// The bug: `cmPaste` in EditorTab.svelte inserted the clipboard with
// `{ changes: {...}, selection: { anchor: from + text.length } }`. CodeMirror
// normalizes line breaks on insert, so CRLF text — i.e. every multi-line paste
// from a Windows application — lands in the document SHORTER than the string it
// came from. The computed anchor then pointed past the end of the document and
// `state.update()` threw a RangeError *before applying the change*, inside an
// unawaited `.then()`. Result: a completely silent, total paste failure.
//
// It reproduced only off macOS (whose clipboard uses LF), and single-line pastes
// worked because they contain no CR — so it read as "pasting only gives me one
// line at a time" rather than as a crash.
//
// The same trap exists for `<textarea>`, whose `value` normalizes CRLF to LF per
// the HTML spec — see `replaceSelection` in actions/clipboardKeys.ts, which now
// measures the caret from the value the DOM actually stored.
//
// This guard fails on any `anchor:`/`head:`/`caret =` expression built from
// `.length` of a clipboard variable. Derive the selection from the applied change
// instead: `view.dispatch(view.state.replaceSelection(text))`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EditorState } from "@codemirror/state";

const SRC = join(process.cwd(), "src");

// `anchor: from + text.length`, `head: start + clip.length`, `caret = a + pasted.length`…
// Any of the clipboard-ish identifiers this codebase uses for pasted content.
const CARET_FROM_RAW_LENGTH =
  /(anchor|head|caret)\s*[:=][^;,\n]*\b(text|clip|clipboard|pasted|paste)\b\.length/i;
// This guard's own prose quotes the shape it forbids.
const EXEMPT = /clipboardpaste\.guard\.test\.ts$/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".svelte") || entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("paste caret guard", () => {
  it("no caret is positioned from the raw length of clipboard text", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (EXEMPT.test(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (CARET_FROM_RAW_LENGTH.test(line)) {
          const rel = file.slice(SRC.length + 1);
          offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(
      offenders,
      `a caret derived from raw clipboard length breaks CRLF (Windows) pastes.\n` +
        `Use view.dispatch(view.state.replaceSelection(text)) instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // Pins the underlying CodeMirror behaviour the guard exists for, so the reason
  // survives even if the regex above ever needs rewriting.
  it("CodeMirror stores CRLF text shorter than the raw string", () => {
    const state = EditorState.create({ doc: "" });
    const text = "line1\r\nline2\r\nline3";
    const applied = state.update({ changes: { from: 0, to: 0, insert: text } });
    expect(applied.state.doc.length).toBeLessThan(text.length);
    // The exact shape of the old bug: anchor past the end is rejected outright.
    expect(() =>
      state.update({
        changes: { from: 0, to: 0, insert: text },
        selection: { anchor: text.length },
      }),
    ).toThrow();
  });

  it("replaceSelection handles CRLF and leaves the caret after the insert", () => {
    const state = EditorState.create({ doc: "X" });
    const tr = state.update(state.replaceSelection("line1\r\nline2\r\nline3"));
    expect(tr.state.doc.toString()).toBe("line1\nline2\nline3X");
    expect(tr.state.selection.main.head).toBe(tr.state.doc.length - 1);
  });
});
