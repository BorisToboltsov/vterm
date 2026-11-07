// Picking several rows of a dock list (v1.33, stage 2): the pure half. A plain
// click on a row opens its details; ⌘/Ctrl-click adds or takes away one row,
// Shift-click takes the run from the last picked row to this one, in the order
// the list shows them; the checkbox in the row does what ⌘-click does, for the
// keyboard. The panel holds the set and acts on it as a whole.

/** How a pick extends the selection. */
export type PickMode = "toggle" | "range";

/** What a click with these keys means: none — not a pick, the row opens instead. */
export function pickMode(e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): PickMode | null {
  if (e.shiftKey) return "range";
  if (e.metaKey || e.ctrlKey) return "toggle";
  return null;
}

/**
 * The selection after a pick. `order` is the rows as shown (a folded group's
 * rows are not shown and so not taken by a range); `anchor` — the last row
 * picked by toggle. A range without an anchor, or with one no longer shown, is
 * a toggle of the one row.
 */
export function pick(
  selected: ReadonlySet<string>,
  order: readonly string[],
  anchor: string | null,
  id: string,
  mode: PickMode,
): Set<string> {
  const next = new Set(selected);
  const from = anchor == null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (mode === "range" && from >= 0 && to >= 0) {
    const [a, b] = from <= to ? [from, to] : [to, from];
    for (const x of order.slice(a, b + 1)) next.add(x);
    return next;
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The selection with rows that are gone taken out; the same set when nothing went. */
export function keepPresent(selected: ReadonlySet<string>, present: readonly string[]): ReadonlySet<string> {
  const live = new Set(present);
  const gone = [...selected].some((id) => !live.has(id));
  return gone ? new Set([...selected].filter((id) => live.has(id))) : selected;
}
