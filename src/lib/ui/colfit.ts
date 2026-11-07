// Which columns of a dock list stand on screen (v1.33): the pure half. A wide
// list is a table, and the table is laid out by the width of the list itself —
// not of the panel around it. With logs open beside the list, the panel is still
// wide but the list has half of it, and before this every column kept its width
// and shrank in proportion: the name, the one thing that says which row is
// which, was cut as hard as the ports. Now a column that does not fit leaves the
// table, in the order the list names, and the name never does.
//
// Two things take a column off the table: the user (the «View» menu — kept in
// `stores/colwidths.svelte.ts`) and the width. Only the second is reported back
// as `dropped`: the header says what the width took («+2»), not what the user
// chose not to see. Widths are px at 100 % (ADR 0049); the caller divides the
// measured width by the interface scale before asking.

import { listColumnWidth, type ListColumn, type ListWidths } from "./colwidths";

/** A cell of a list row that stands as a column of the table. */
export interface ListField {
  id: string;
  /** A resizable column: its width is the user's (`colwidths.ts`). */
  col?: ListColumn;
  /** Otherwise a fixed width, px at 100 % — the same as the cell's class. */
  width?: number;
  /** The user may take it off the table; the name and the actions never. */
  hideable: boolean;
}

export interface FieldList {
  /** In display order. */
  fields: readonly ListField[];
  /** What every row has besides its fields, px at 100 %: padding, the state dot, gaps, a scrollbar. */
  fixed: number;
  /** The order the fields leave in when the list is too narrow for them; a field not named here stays. */
  drop: readonly string[];
}

/**
 * The tables of the dock lists. The drop order goes from what a narrow list can
 * best do without to what it needs: where a container is reachable matters less
 * than what it runs, and what it runs less than whether it is up.
 */
export const LIST_FIELDS = {
  "docker.containers": {
    fields: [
      { id: "name", col: "docker.name", hideable: false },
      { id: "image", col: "docker.image", hideable: true },
      { id: "state", col: "docker.status", hideable: true },
      { id: "ports", col: "docker.ports", hideable: true },
      { id: "ip", col: "docker.ip", hideable: true },
      // The CPU shape and the hover actions share one box (`w-[6.5rem]`).
      { id: "cpu", width: 104, hideable: false },
    ],
    fixed: 56,
    drop: ["ports", "image", "ip", "state"],
  },
  "k8s.pods": {
    fields: [
      { id: "name", col: "k8s.name", hideable: false },
      { id: "namespace", col: "k8s.namespace", hideable: true },
      { id: "ip", col: "k8s.ip", hideable: true },
      { id: "node", col: "k8s.node", hideable: true },
      { id: "ready", width: 64, hideable: false },
      { id: "restarts", width: 48, hideable: true },
      { id: "spark", width: 52, hideable: true },
      { id: "cpu", width: 80, hideable: false },
      { id: "mem", width: 80, hideable: true },
      { id: "limits", width: 112, hideable: true },
      { id: "age", width: 72, hideable: true },
      { id: "actions", width: 56, hideable: false },
    ],
    fixed: 48,
    drop: ["limits", "spark", "ip", "namespace", "node", "mem", "age", "restarts"],
  },
} as const satisfies Record<string, FieldList>;

export type FieldListId = keyof typeof LIST_FIELDS;

/** The fields of a list the user may take off its table. */
export function hideableFields(list: FieldListId): string[] {
  return LIST_FIELDS[list].fields.filter((f) => f.hideable).map((f) => f.id);
}

/** A field's width at 100 %: the user's for a resizable column, else its own. */
export function fieldWidth(field: ListField, widths: ListWidths): number {
  return field.col ? listColumnWidth(widths, field.col) : (field.width ?? 0);
}

export interface ColumnFit {
  /** The fields on the table, in display order. */
  shown: string[];
  /** What the width took off, in the order it went — not what the user hid. */
  dropped: string[];
}

/**
 * The fields of `list` that stand on a table `room` px (at 100 %) wide, given the
 * user's widths and what the user hid. `first` leaves before the list's own drop
 * order — a column every row has the same value in (one namespace) says nothing.
 * A width not measured yet (0) keeps every field: the first frame is not a reason
 * to throw columns away.
 */
export function fitColumns(
  list: FieldListId,
  widths: ListWidths,
  hidden: readonly string[],
  room: number,
  first: readonly string[] = [],
): ColumnFit {
  const spec: FieldList = LIST_FIELDS[list];
  const kept = spec.fields.filter((f) => !(f.hideable && hidden.includes(f.id)));
  const width = new Map(kept.map((f) => [f.id, fieldWidth(f, widths)]));
  const shown = new Set(kept.map((f) => f.id));
  const dropped: string[] = [];
  if (room > 0) {
    let total = spec.fixed + [...width.values()].reduce((a, b) => a + b, 0);
    for (const id of [...first, ...spec.drop]) {
      if (total <= room) break;
      if (!shown.has(id)) continue;
      shown.delete(id);
      dropped.push(id);
      total -= width.get(id) ?? 0;
    }
  }
  return { shown: kept.map((f) => f.id).filter((id) => shown.has(id)), dropped };
}

export type HiddenFields = Partial<Record<FieldListId, string[]>>;

/**
 * What the user hid (`vterm.columns.hidden`) made safe to use: known lists, and
 * of each only fields it lets the user hide, once each. Storage is user-writable
 * and outlives the build that wrote it.
 */
export function sanitizeHiddenFields(raw: unknown): HiddenFields {
  const out: HiddenFields = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [list, ids] of Object.entries(raw)) {
    if (!Object.hasOwn(LIST_FIELDS, list) || !Array.isArray(ids)) continue;
    const allowed = hideableFields(list as FieldListId);
    const kept = [...new Set(ids.filter((id): id is string => typeof id === "string" && allowed.includes(id)))];
    if (kept.length > 0) out[list as FieldListId] = kept;
  }
  return out;
}

/** The hidden fields of a list after the user flips one; a field it may not hide stays as it is. */
export function toggleHidden(hidden: readonly string[], list: FieldListId, id: string): string[] {
  if (!hideableFields(list).includes(id)) return [...hidden];
  return hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
}
