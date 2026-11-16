// How a file indents (ADR 0076): `.editorconfig` first, then what the file
// itself does, then the language's custom. Before this the editor put two
// spaces on every Tab and Enter — a Python block grew a 2-space body inside a
// 4-space file, a Makefile recipe got spaces where make demands a tab.

import type { EditorLangKind } from "./editorlang";

/** One level of indentation: a tab, or a number of spaces. */
export interface IndentInfo {
  tabs: boolean;
  /** Spaces per level; for tabs — the tab width the file is shown with. */
  width: number;
}

/** Where the indentation the editor uses came from — said in the status bar. */
export type IndentSource = "editorconfig" | "file" | "language";

const LINES = 4000;

/**
 * The indentation a text uses, or null when it does not indent enough to say.
 * Tabs win when more lines start with a tab than with spaces; the space width is
 * the most common step between consecutive indented lines (2, 3, 4 or 8) — the
 * step, not the depth, so a deeply nested 2-space file is not read as 8.
 */
export function detectIndent(text: string): IndentInfo | null {
  let tabLines = 0;
  let spaceLines = 0;
  const steps = new Map<number, number>();
  let prev = 0;
  let n = 0;
  for (const line of text.split("\n")) {
    if (++n > LINES) break;
    if (line.trim() === "") continue;
    if (line[0] === "\t") {
      tabLines++;
      prev = 0;
      continue;
    }
    let lead = 0;
    while (line[lead] === " ") lead++;
    // A ` * ` continuing a block comment says nothing about the indent.
    if (line[lead] === "*" && lead % 2 === 1) continue;
    if (lead > 0) spaceLines++;
    const step = Math.abs(lead - prev);
    if (step > 0 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    prev = lead;
  }
  if (tabLines === 0 && spaceLines === 0) return null;
  if (tabLines > spaceLines) return { tabs: true, width: 4 };
  let best = 0;
  let count = 0;
  for (const w of [2, 4, 8, 3]) {
    const c = steps.get(w) ?? 0;
    if (c > count) {
      best = w;
      count = c;
    }
  }
  return best ? { tabs: false, width: best } : null;
}

/** The custom of a language, when neither `.editorconfig` nor the file says. */
export function languageIndent(kind: EditorLangKind, name: string): IndentInfo {
  const base = name.toLowerCase();
  if (base === "makefile" || base === "gnumakefile" || base.endsWith(".mk")) return { tabs: true, width: 4 };
  switch (kind) {
    case "go":
      return { tabs: true, width: 4 };
    case "python":
    case "rust":
    case "java":
    case "c":
    case "cpp":
    case "csharp":
    case "kotlin":
    case "scala":
    case "powershell":
    case "perl":
    case "dockerfile":
    case "sql":
      return { tabs: false, width: 4 };
    default:
      return { tabs: false, width: 2 };
  }
}

/** The string one level of `info` inserts. */
export function indentString(info: IndentInfo): string {
  return info.tabs ? "\t" : " ".repeat(info.width);
}

/**
 * The indentation for a file: `.editorconfig` (when it names a style), then the
 * text, then the language. A size the `.editorconfig` gives without a style
 * still sizes what the file is found to use.
 */
export function resolveIndent(
  text: string,
  kind: EditorLangKind,
  name: string,
  ec: { tabs?: boolean; width?: number },
): { info: IndentInfo; source: IndentSource } {
  if (ec.tabs !== undefined) {
    const lang = languageIndent(kind, name);
    return { info: { tabs: ec.tabs, width: ec.width ?? lang.width }, source: "editorconfig" };
  }
  const found = detectIndent(text);
  if (found) return { info: found, source: "file" };
  const lang = languageIndent(kind, name);
  return { info: ec.width ? { tabs: lang.tabs, width: ec.width } : lang, source: ec.width ? "editorconfig" : "language" };
}

/**
 * Leading whitespace of every line rewritten to `info` — the "whitespace only"
 * format and the status bar's convert. Each existing level is counted with
 * `from` (a tab is one level, `from.width` spaces are one level); a remainder
 * smaller than a level is kept as spaces so alignment inside a level survives.
 * The same `from` and `to` still evens a mix: a stray tab becomes the unit.
 */
export function reindent(text: string, from: IndentInfo, to: IndentInfo): string {
  return text
    .split("\n")
    .map((line) => {
      let i = 0;
      let levels = 0;
      let spaces = 0;
      while (i < line.length && (line[i] === " " || line[i] === "\t")) {
        if (line[i] === "\t") {
          levels++;
          spaces = 0;
        } else if (++spaces === from.width) {
          levels++;
          spaces = 0;
        }
        i++;
      }
      if (i === 0) return line;
      return indentString(to).repeat(levels) + " ".repeat(spaces) + line.slice(i);
    })
    .join("\n");
}
