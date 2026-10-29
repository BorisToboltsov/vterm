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
// The lint rule `vterm/paste-caret` fails on any `anchor:`/`head:`/`caret =`
// expression built from `.length` of a clipboard variable. Derive the selection
// from the applied change instead: `view.dispatch(view.state.replaceSelection(text))`.
// What stays here pins the CodeMirror behaviour the rule exists for, so the reason
// survives a rewrite of the rule.

import { describe, expect, it } from "vitest";

import { EditorState } from "@codemirror/state";

describe("paste caret guard", () => {
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
