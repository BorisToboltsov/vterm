// Drag-resizable column widths: the pure half. The widths map belongs to whoever
// draws the table — the structured log view keeps its own (columns come and go
// with the log's fields), the dock lists share the persisted store in
// `stores/colwidths.svelte.ts` — but the arithmetic is one and lives here (ADR 0003).

/** Smallest a column may be dragged to. */
export const COL_MIN = 56;
/** Largest a persisted column may be — a stored width must fit a real window. */
export const COL_MAX = 960;

/** Current width for column `key`, or `fallback` if it was never resized. */
export function colWidth(
  widths: Record<string, number>,
  key: string,
  fallback: number,
): number {
  const w = widths[key];
  return typeof w === "number" && w > 0 ? w : fallback;
}

/** New width for a column being dragged from `start` by signed delta `dx`. */
export function resizedWidth(start: number, dx: number, min = COL_MIN): number {
  return Math.max(min, Math.round(start + dx));
}

/**
 * The resizable columns of the dock lists and the width each starts with (px).
 * They only exist in a wide container (`@wide:`): a narrow dock stacks the same
 * data into two-line rows and has no columns to size.
 */
export const LIST_COLUMNS = {
  "docker.name": 200,
  "docker.image": 260,
  "docker.status": 150,
  "docker.ports": 220,
  "k8s.name": 280,
  "k8s.namespace": 130,
  "k8s.node": 170,
  "files.name": 320,
  "files.owner": 150,
} as const;

export type ListColumn = keyof typeof LIST_COLUMNS;

export const isListColumn = (v: unknown): v is ListColumn =>
  typeof v === "string" && Object.hasOwn(LIST_COLUMNS, v);

/** A width brought back inside what a column may be. */
export const clampColumn = (px: number): number =>
  Math.max(COL_MIN, Math.min(COL_MAX, Math.round(px)));

export type ListWidths = Partial<Record<ListColumn, number>>;

/**
 * The stored widths (`vterm.columns`) made safe to use: only known columns, only
 * finite numbers, clamped. Storage is user-writable and outlives the build that
 * wrote it — a width of `NaN` or `1e9` would land in a CSS variable as is.
 */
export function sanitizeListWidths(raw: unknown): ListWidths {
  const out: ListWidths = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (isListColumn(key) && typeof value === "number" && Number.isFinite(value)) {
      out[key] = clampColumn(value);
    }
  }
  return out;
}

/** The width a list column is drawn at: the user's, or the one it starts with. */
export function listColumnWidth(widths: ListWidths, col: ListColumn): number {
  return widths[col] ?? LIST_COLUMNS[col];
}

/**
 * CSS custom properties for a list's columns — `{ "--c-name": "200px", … }` as a
 * `style` string. The rows and the header read the same variables, so a drag
 * re-sizes every row through one style write instead of one per row.
 */
export function columnVars(widths: ListWidths, vars: Record<string, ListColumn>): string {
  return Object.entries(vars)
    .map(([name, col]) => `${name}: ${listColumnWidth(widths, col)}px`)
    .join("; ");
}
