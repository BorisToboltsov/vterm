// A multi-line clipboard paste needs an explicit shape before it reaches xterm.
// Keeping this transformation pure makes the exact bytes reviewable in the
// dialog and testable without a terminal or clipboard.

export type TerminalPasteMode = "exact" | "single" | "continued";

/** Normalise platform line endings for preview and transformation. */
export function normalisePasteText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Whether the clipboard carries more than one physical line. */
export function isMultilinePaste(text: string): boolean {
  return normalisePasteText(text).includes("\n");
}

/**
 * Shell constructs whose meaning is especially easy to change by joining lines.
 * This is advisory: the preview remains the source of truth and the user can
 * still choose either representation.
 */
export function hasPasteStructureRisk(text: string): boolean {
  const body = normalisePasteText(text);
  return /(^|[ \t])#/mu.test(body) || /(^|\s)<<-?\s*['"]?[A-Za-z_][\w-]*['"]?/u.test(body);
}

/** Produce exactly what the selected paste option will hand to `term.paste()`. */
export function transformTerminalPaste(text: string, mode: TerminalPasteMode): string {
  const body = normalisePasteText(text);
  if (mode === "exact") return body;
  if (mode === "single") {
    return body
      .replace(/[ \t]*\\[ \t]*\n[ \t]*/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, " ");
  }

  const lines = body.replace(/\n+$/u, "").split("\n");
  return lines
    .map((line, index) => {
      if (index === lines.length - 1) return line;
      const trimmed = line.replace(/[ \t]+$/u, "");
      return /\\$/u.test(trimmed) ? trimmed : `${trimmed} \\`;
    })
    .join("\n");
}
