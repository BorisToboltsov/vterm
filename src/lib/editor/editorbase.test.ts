import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldable, indentUnit } from "@codemirror/language";
import { CompletionContext } from "@codemirror/autocomplete";
import {
  folding,
  foldsByIndent,
  indentFoldRange,
  indentation,
  leadColumns,
  multiCursor,
  snippetSource,
  type EditorWords,
} from "./editorbase";

const WORDS: EditorWords = { folded: (n) => `⋯ ${n}`, fold: "fold", unfold: "unfold", snippet: "snippet" };

describe("leadColumns", () => {
  it("expands tabs to the next stop", () => {
    expect(leadColumns("    x", 4)).toEqual({ cols: 4, chars: 4 });
    expect(leadColumns("\tx", 4)).toEqual({ cols: 4, chars: 1 });
    expect(leadColumns("  \tx", 4)).toEqual({ cols: 4, chars: 3 });
    expect(leadColumns("x", 4)).toEqual({ cols: 0, chars: 0 });
  });
});

describe("indentFoldRange", () => {
  const lines = ["server {", "    listen 80;", "", "    location / {", "        root /srv;", "    }", "}", ""];
  it("folds what is indented deeper, blank lines inside included", () => {
    expect(indentFoldRange(lines, 1, 4)).toEqual({ endLine: 6 });
    expect(indentFoldRange(lines, 4, 4)).toEqual({ endLine: 5 });
  });
  it("does not fold a line with nothing deeper after it", () => {
    expect(indentFoldRange(lines, 2, 4)).toBeNull();
    expect(indentFoldRange(lines, 3, 4)).toBeNull();
  });
});

describe("folding by indentation", () => {
  it("offers a fold where the grammar has none", () => {
    const state = EditorState.create({
      doc: "server {\n    listen 80;\n    root /srv;\n}\n",
      extensions: [folding(WORDS, true)],
    });
    expect(foldable(state, 0, state.doc.line(1).to)).toEqual({ from: state.doc.line(1).to, to: state.doc.line(3).to });
  });

  it("knows which kinds fold by their tree", () => {
    expect(foldsByIndent("nginx")).toBe(true);
    expect(foldsByIndent("hcl")).toBe(true);
    expect(foldsByIndent("python")).toBe(false);
    expect(foldsByIndent("yaml")).toBe(false);
  });
});

describe("several cursors", () => {
  it("lets a state hold more than one selection", () => {
    const state = EditorState.create({ doc: "a a", extensions: [multiCursor()] });
    expect(state.facet(EditorState.allowMultipleSelections)).toBe(true);
    // Without the facet CodeMirror keeps only the main range — ⌘D added nothing.
    const plain = EditorState.create({ doc: "a a" });
    expect(plain.facet(EditorState.allowMultipleSelections)).toBe(false);
  });
});

describe("indentation", () => {
  it("sets the unit and tab width from the file", () => {
    const s = EditorState.create({ extensions: [indentation({ tabs: false, width: 4 })] });
    expect(s.facet(indentUnit)).toBe("    ");
    const t = EditorState.create({ extensions: [indentation({ tabs: true, width: 8 })] });
    expect(t.facet(indentUnit)).toBe("\t");
    expect(t.tabSize).toBe(8);
  });
});

describe("snippetSource", () => {
  it("offers the language's snippets with their detail", () => {
    const src = snippetSource([{ name: "server-block", body: "server {\n  listen 80;\n}" }], "snippet");
    const state = EditorState.create({ doc: "ser" });
    const res = src(new CompletionContext(state, 3, false));
    expect(res && "options" in res ? res.options.map((o) => [o.label, o.detail]) : null).toEqual([["server-block", "snippet"]]);
  });

  it("stays quiet on an empty position unless asked", () => {
    const src = snippetSource([{ name: "x", body: "y" }], "snippet");
    const state = EditorState.create({ doc: " " });
    expect(src(new CompletionContext(state, 1, false))).toBeNull();
    expect(src(new CompletionContext(state, 1, true))).not.toBeNull();
  });
});

describe("in a view", () => {
  it("mounts with every part on", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: "a:\n  b: 1\n", extensions: [folding(WORDS, false), multiCursor(), indentation({ tabs: false, width: 2 })] }),
    });
    expect(parent.querySelector(".cm-foldGutter")).not.toBeNull();
    view.destroy();
  });
});
