// Column widths of the dock lists (v1.1): Docker containers and k8s pods lay out
// as a table in a wide container, and the user drags the column borders. The
// widths live here, not in the component: a session panel is rebuilt on every
// terminal-tab switch, and a width that reset each time would not be a setting.
// Persisted to localStorage under `vterm.columns`; the arithmetic and the
// sanitizer are pure (`../colwidths.ts`).

import {
  clampColumn,
  listColumnWidth,
  sanitizeListWidths,
  type ListColumn,
  type ListWidths,
} from "../colwidths";

export const STORAGE_KEY = "vterm.columns";

function load(): ListWidths {
  try {
    return sanitizeListWidths(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return {};
  }
}

export const columns = $state<{ widths: ListWidths }>({ widths: load() });

/** The width a column is drawn at (reactive). */
export function columnWidth(col: ListColumn): number {
  return listColumnWidth(columns.widths, col);
}

export function setColumnWidth(col: ListColumn, px: number): void {
  columns.widths[col] = clampColumn(px);
}

/** Back to the width the column starts with (double-click on its border). */
export function resetColumnWidth(col: ListColumn): void {
  delete columns.widths[col];
}

/** Every column back to its default ("Reset panel layout", and tests). */
export function resetColumnWidths(): void {
  columns.widths = {};
}

$effect.root(() => {
  $effect(() => {
    const data = JSON.stringify(columns.widths);
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch {
      /* storage unavailable — non-fatal */
    }
  });
});
