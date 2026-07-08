// Pure OS-style multi-select reducer for the file panels (SftpPanel/LocalFilePanel).
// Plain click selects one; Ctrl/Cmd click toggles; Shift click selects the range
// from the anchor to the clicked row. DOM-free so the rules are unit-tested.
// `order` is the paths of the currently visible rows, top to bottom (shift-range).

export interface SelectionState {
  selected: Set<string>;
  /** The last row clicked without Shift — the fixed end of a Shift-range. */
  anchor: string | null;
}

export interface ClickMods {
  /** Ctrl (Windows/Linux) or Cmd (macOS): toggle one row in/out of the selection. */
  toggle: boolean;
  /** Shift: select the contiguous range from the anchor to this row. */
  range: boolean;
}

export function emptySelection(): SelectionState {
  return { selected: new Set(), anchor: null };
}

export function clickSelect(
  state: SelectionState,
  path: string,
  mods: ClickMods,
  order: string[],
): SelectionState {
  if (mods.range && state.anchor) {
    const i = order.indexOf(state.anchor);
    const j = order.indexOf(path);
    if (i >= 0 && j >= 0) {
      const [lo, hi] = i <= j ? [i, j] : [j, i];
      // Anchor stays put so the range can be re-dragged with further Shift-clicks.
      return { selected: new Set(order.slice(lo, hi + 1)), anchor: state.anchor };
    }
    // Anchor scrolled out of the list / no longer present → treat as a plain click.
  }
  if (mods.toggle) {
    const selected = new Set(state.selected);
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    return { selected, anchor: path };
  }
  return { selected: new Set([path]), anchor: path };
}
