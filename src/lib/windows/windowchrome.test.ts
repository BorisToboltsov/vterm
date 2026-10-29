import { describe, expect, it } from "vitest";
import { GRAB, menuAnchor, resizeEdges, type ResizeDir } from "./windowchrome";

describe("resizeEdges", () => {
  it("returns the eight edges/corners with unique directions", () => {
    const edges = resizeEdges();
    expect(edges).toHaveLength(8);
    const ids = edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(8);
    const expected: ResizeDir[] = [
      "North",
      "South",
      "East",
      "West",
      "NorthEast",
      "NorthWest",
      "SouthEast",
      "SouthWest",
    ];
    expect(new Set(ids)).toEqual(new Set(expected));
    // Each edge hands its own direction to Tauri.
    for (const e of edges) expect(e.dir).toBe(e.id);
  });

  it("gives corners diagonal cursors and sides axis cursors", () => {
    const by = Object.fromEntries(resizeEdges().map((e) => [e.id, e]));
    expect(by.North.cursor).toBe("ns-resize");
    expect(by.South.cursor).toBe("ns-resize");
    expect(by.East.cursor).toBe("ew-resize");
    expect(by.West.cursor).toBe("ew-resize");
    // NW/SE share one diagonal, NE/SW the other.
    expect(by.NorthWest.cursor).toBe("nwse-resize");
    expect(by.SouthEast.cursor).toBe("nwse-resize");
    expect(by.NorthEast.cursor).toBe("nesw-resize");
    expect(by.SouthWest.cursor).toBe("nesw-resize");
  });

  it("insets side strips by the grab size so corners own the overlap", () => {
    const g = 6;
    const by = Object.fromEntries(resizeEdges(g).map((e) => [e.id, e]));
    // Top side starts and ends `g`px in from the corners.
    expect(by.North.style).toContain(`left:${g}px`);
    expect(by.North.style).toContain(`right:${g}px`);
    expect(by.North.style).toContain(`height:${g}px`);
    // Corner is a flush g×g square in its corner.
    expect(by.NorthWest.style).toContain("top:0");
    expect(by.NorthWest.style).toContain("left:0");
    expect(by.NorthWest.style).toContain(`width:${g}px`);
    expect(by.NorthWest.style).toContain(`height:${g}px`);
  });

  it("defaults the strip thickness to GRAB", () => {
    expect(resizeEdges()[0].style).toContain(`height:${GRAB}px`);
  });
});

describe("menuAnchor", () => {
  it("anchors under the button's bottom-left corner", () => {
    expect(menuAnchor({ left: 40, bottom: 32 })).toEqual({ x: 40, y: 32 });
  });
});
