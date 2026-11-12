// Column widths of the dock lists (v1.1): Docker containers and k8s pods lay out
// as a table in a wide container, and the user drags the column borders. The
// widths live here, not in the component: a session panel is rebuilt on every
// terminal-tab switch, and a width that reset each time would not be a setting.
// Persisted to localStorage under `vterm.columns`; the arithmetic and the
// sanitizer are pure (`../colwidths.ts`).
//
// Which columns the user took off a table (v1.33, the «View» menu) live here
// too, under `vterm.columns.hidden`: what fits the width is decided anew on every
// resize (`../ui/colfit.ts`), what the user hid is a setting.

import { swallowed } from "../api/diag";
import {
  clampColumn,
  listColumnWidth,
  sanitizeListWidths,
  type ListColumn,
  type ListWidths,
} from "../ui/colwidths";
import { sanitizeHiddenFields, toggleHidden, type FieldListId, type HiddenFields } from "../ui/colfit";

export const STORAGE_KEY = "vterm.columns";
export const HIDDEN_KEY = "vterm.columns.hidden";

function load(): ListWidths {
  try {
    return sanitizeListWidths(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return {};
  }
}

function loadHidden(): HiddenFields {
  try {
    return sanitizeHiddenFields(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "null"));
  } catch {
    return {};
  }
}

export const columns = $state<{ widths: ListWidths; hidden: HiddenFields }>({
  widths: load(),
  hidden: loadHidden(),
});

/** The fields the user took off a list's table (reactive). */
export function hiddenFields(list: FieldListId): string[] {
  return columns.hidden[list] ?? [];
}

/** Take a field off a list's table, or put it back. */
export function toggleField(list: FieldListId, id: string): void {
  const next = toggleHidden(hiddenFields(list), list, id);
  if (next.length > 0) columns.hidden[list] = next;
  else delete columns.hidden[list];
}

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
  columns.hidden = {};
}

$effect.root(() => {
  $effect(() => {
    const data = JSON.stringify(columns.widths);
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch (e) {
      /* storage unavailable — non-fatal */
      swallowed("settings", "the column widths were not saved", e, "warn");
    }
  });
  $effect(() => {
    const data = JSON.stringify(columns.hidden);
    try {
      localStorage.setItem(HIDDEN_KEY, data);
    } catch (e) {
      /* storage unavailable — non-fatal */
      swallowed("settings", "the hidden columns were not saved", e, "warn");
    }
  });
});
