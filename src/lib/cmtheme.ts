// Build a CodeMirror theme + syntax-highlight style from vterm's active terminal
// palette, so the editor reads as part of the app under any theme (the locked
// design system — colours come from theme tokens, never raw hex). One function
// the editor calls with `activeTerminalTheme()`; `isDark` is a pure helper.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { TerminalTheme } from "./themes";

/** Perceived-luminance test on a `#rrggbb` background (dark ⇒ light text). */
export function isDark(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/** CodeMirror extensions theming the editor chrome + syntax to a terminal palette. */
export function editorTheme(term: TerminalTheme): Extension {
  const dark = isDark(term.background);
  // Subtle active-line wash that works on both light and dark backgrounds.
  const wash = dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";

  const view = EditorView.theme(
    {
      "&": { color: term.foreground, backgroundColor: term.background },
      ".cm-content": { caretColor: term.cursor },
      "&.cm-focused .cm-cursor": { borderLeftColor: term.cursor },
      ".cm-selectionBackground, .cm-content ::selection, &.cm-focused .cm-selectionBackground":
        { backgroundColor: term.selectionBackground },
      ".cm-gutters": {
        backgroundColor: term.background,
        color: term.brightBlack,
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: wash },
      ".cm-activeLineGutter": { backgroundColor: wash, color: term.foreground },
      ".cm-lineNumbers .cm-gutterElement": { color: term.brightBlack },
    },
    { dark },
  );

  const highlight = HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment], color: term.brightBlack, fontStyle: "italic" },
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword], color: term.magenta },
    { tag: [t.string, t.special(t.string), t.docString], color: term.green },
    { tag: [t.number, t.bool, t.null, t.atom], color: term.yellow },
    { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: term.blue },
    { tag: [t.typeName, t.className, t.tagName, t.namespace], color: term.cyan },
    { tag: [t.variableName, t.definition(t.variableName)], color: term.foreground },
    { tag: [t.heading], color: term.blue, fontWeight: "bold" },
    { tag: [t.link, t.url], color: term.cyan, textDecoration: "underline" },
    { tag: [t.invalid], color: term.red },
  ]);

  return [view, syntaxHighlighting(highlight)];
}
