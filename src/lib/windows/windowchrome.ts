// Pure geometry/config for the custom (frameless) window chrome used on
// Windows/Linux — [TitleBar.svelte](./TitleBar.svelte) is the thin shell over it.
// macOS keeps its native title bar, so none of this runs there. Kept DOM-free so
// the resize-edge mapping and menu anchoring are unit-tested without a window
// (invariant: dumb backend, pure logic in .ts).

// Mirrors the `ResizeDirection` string union from @tauri-apps/api/window. The
// runtime values are exactly these strings, so TitleBar passes them straight to
// `getCurrentWindow().startResizeDragging(dir)` without importing the enum.
export type ResizeDir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

/** One resize-sensitive strip pinned to a window edge or corner. */
export interface ResizeEdge {
  /** Stable key (also the Tauri direction). */
  id: ResizeDir;
  /** Direction handed to `startResizeDragging`. */
  dir: ResizeDir;
  /** CSS cursor affordance for this edge/corner. */
  cursor: string;
  /** Inline style positioning a `position: fixed` strip against the edge. */
  style: string;
}

/** Thickness (px) of the invisible edge/corner grab strips. */
export const GRAB = 6;

/**
 * The eight grab strips for a frameless window, as pure data. Sides are inset by
 * `grab` at both ends so the four corners own the diagonal-resize overlap (a
 * corner drag resizes two axes at once). Consumers render each as a fixed,
 * transparent element and start `dir` resizing on pointer-down.
 */
export function resizeEdges(grab: number = GRAB): ResizeEdge[] {
  const g = `${grab}px`;
  return [
    // Sides — inset by `grab` on both ends to leave the corners their square.
    { id: "North", dir: "North", cursor: "ns-resize", style: `top:0;left:${g};right:${g};height:${g}` },
    { id: "South", dir: "South", cursor: "ns-resize", style: `bottom:0;left:${g};right:${g};height:${g}` },
    { id: "West", dir: "West", cursor: "ew-resize", style: `top:${g};bottom:${g};left:0;width:${g}` },
    { id: "East", dir: "East", cursor: "ew-resize", style: `top:${g};bottom:${g};right:0;width:${g}` },
    // Corners — square, diagonal cursors.
    { id: "NorthWest", dir: "NorthWest", cursor: "nwse-resize", style: `top:0;left:0;width:${g};height:${g}` },
    { id: "NorthEast", dir: "NorthEast", cursor: "nesw-resize", style: `top:0;right:0;width:${g};height:${g}` },
    { id: "SouthWest", dir: "SouthWest", cursor: "nesw-resize", style: `bottom:0;left:0;width:${g};height:${g}` },
    { id: "SouthEast", dir: "SouthEast", cursor: "nwse-resize", style: `bottom:0;right:0;width:${g};height:${g}` },
  ];
}

/** A viewport point. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Where a menu-bar dropdown opens: flush under the button's bottom-left corner.
 * The shared ContextMenu clamps this to the viewport, so this only needs to pick
 * the anchor, not worry about spilling off-screen.
 */
export function menuAnchor(rect: { left: number; bottom: number }): Point {
  return { x: rect.left, y: rect.bottom };
}
