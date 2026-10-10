import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  activateTab,
  activeTab,
  addTab,
  addTabBehind,
  applyDrop,
  arrivalDrop,
  canSplit,
  clampRatio,
  dropChanges,
  EDGES,
  emptyLayout,
  findPane,
  focusPane,
  focusedPane,
  gridFit,
  joinPanes,
  layoutProblems,
  layoutRects,
  loadLayout,
  moveTab,
  neighbourPane,
  nudgedRatio,
  orderedTabs,
  PANE_LIMITS,
  paneOf,
  panes,
  paneZone,
  placeTab,
  previewIncoming,
  previewTabs,
  RATIO_MAX,
  RATIO_MIN,
  ratioAt,
  removeTab,
  sameDrop,
  sameRect,
  savedLayout,
  setRatio,
  shownTabs,
  splitWithTab,
  tileTabs,
  zoneRect,
  type CenterLayout,
  type Edge,
  type LayoutNode,
  type PaneZone,
  type TabDrop,
} from "./splitlayout";

/** A layout with tabs opened one after another in the focused pane. */
function withTabs(...tabs: string[]): CenterLayout {
  return tabs.reduce((l, t) => addTab(l, t), emptyLayout());
}

/** Tabs per pane in reading order — the shape most assertions care about. */
const shape = (l: CenterLayout): string[][] => panes(l).map((p) => p.tabs);

/** `[a b] | [c]` with `c` in focus. */
function twoPanes(): CenterLayout {
  return splitWithTab(withTabs("a", "b", "c"), "c", "p0", "right");
}

describe("an empty centre", () => {
  it("is one empty pane in focus", () => {
    const l = emptyLayout();
    expect(shape(l)).toEqual([[]]);
    expect(activeTab(l)).toBeNull();
    expect(focusedPane(l).id).toBe(l.focus);
    expect(layoutProblems(l, [])).toEqual([]);
  });
});

describe("opening and closing tabs", () => {
  it("a new tab joins the focused pane, is shown and takes focus", () => {
    const l = withTabs("a", "b");
    expect(shape(l)).toEqual([["a", "b"]]);
    expect(activeTab(l)).toBe("b");
  });

  it("a tab already open is only brought to the front", () => {
    const l = addTab(withTabs("a", "b"), "a");
    expect(shape(l)).toEqual([["a", "b"]]);
    expect(activeTab(l)).toBe("a");
  });

  it("a new tab can be sent to a named pane", () => {
    const two = twoPanes();
    const l = addTab(two, "d", "p0");
    expect(shape(l)).toEqual([["a", "b", "d"], ["c"]]);
    expect(l.focus).toBe("p0");
    // An unknown pane falls back to the focused one.
    expect(shape(addTab(two, "d", "nope"))).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("closing the shown tab shows the neighbour that takes its slot", () => {
    const l = activateTab(withTabs("a", "b", "c"), "b");
    expect(activeTab(removeTab(l, "b"))).toBe("c");
    expect(activeTab(removeTab(withTabs("a", "b", "c"), "c"))).toBe("b");
    // Closing a background tab leaves the shown one alone.
    expect(activeTab(removeTab(withTabs("a", "b", "c"), "a"))).toBe("c");
  });

  it("closing the last tab leaves one empty pane", () => {
    const l = removeTab(withTabs("a"), "a");
    expect(shape(l)).toEqual([[]]);
    expect(activeTab(l)).toBeNull();
  });

  it("a pane emptied by closing its last tab is removed, and focus follows", () => {
    const two = twoPanes(); // c is alone on the right, in focus
    const l = removeTab(two, "c");
    expect(shape(l)).toEqual([["a", "b"]]);
    expect(l.root.kind).toBe("pane");
    expect(activeTab(l)).toBe("b");
  });

  it("closing a tab in a pane that is not in focus keeps the focus", () => {
    const two = focusPane(twoPanes(), "p0");
    const l = removeTab(two, "c");
    expect(l.focus).toBe("p0");
    expect(shape(l)).toEqual([["a", "b"]]);
  });

  it("closing every tab closes every pane but one", () => {
    let l = splitWithTab(twoPanes(), "b", "p0", "bottom"); // [a]/[b] | [c]
    expect(panes(l)).toHaveLength(3);
    for (const tab of ["a", "b", "c"]) l = removeTab(l, tab);
    expect(shape(l)).toEqual([[]]);
    expect(l.root.kind).toBe("pane");
    expect(layoutProblems(l, [])).toEqual([]);
  });

  it("unknown tabs are ignored", () => {
    const l = withTabs("a");
    expect(removeTab(l, "zz")).toBe(l);
    expect(activateTab(l, "zz")).toBe(l);
  });
});

describe("focus", () => {
  it("activating a tab focuses its pane", () => {
    const l = activateTab(twoPanes(), "a");
    expect(l.focus).toBe("p0");
    expect(activeTab(l)).toBe("a");
    // The other pane keeps showing its own tab.
    expect(shownTabs(l)).toEqual(["a", "c"]);
  });

  it("focusing a pane changes nothing else", () => {
    const two = twoPanes();
    const l = focusPane(two, "p0");
    expect(activeTab(l)).toBe("b");
    expect(focusPane(l, "p0")).toBe(l);
    expect(focusPane(l, "nope")).toBe(l);
  });

  it("the next and previous pane wrap round in reading order", () => {
    const l = twoPanes();
    const [left, right] = panes(l);
    expect(neighbourPane(l, left.id, 1).id).toBe(right.id);
    expect(neighbourPane(l, right.id, 1).id).toBe(left.id);
    expect(neighbourPane(l, left.id, -1).id).toBe(right.id);
  });
});

describe("moving tabs", () => {
  it("reorders within a pane without touching the shown tab or the focus", () => {
    const l = withTabs("a", "b", "c"); // shows c
    const moved = moveTab(l, "a", "p0", 2);
    expect(shape(moved)).toEqual([["b", "c", "a"]]);
    expect(activeTab(moved)).toBe("c");
    // The index counts the pane's OTHER tabs: slot 0 of [b c] is the front.
    expect(shape(moveTab(l, "c", "p0", 0))).toEqual([["c", "a", "b"]]);
  });

  it("a move that changes nothing returns the same layout", () => {
    const l = withTabs("a", "b", "c");
    expect(moveTab(l, "b", "p0", 1)).toBe(l);
    expect(moveTab(l, "c", "p0")).toBe(l);
  });

  it("into another pane: the tab is shown there and the pane takes focus", () => {
    const two = focusPane(twoPanes(), "p0");
    const right = panes(two)[1].id;
    const l = moveTab(two, "a", right, 0);
    expect(shape(l)).toEqual([["b"], ["a", "c"]]);
    expect(l.focus).toBe(right);
    expect(activeTab(l)).toBe("a");
  });

  it("moving a pane's last tab away removes the pane", () => {
    const two = twoPanes();
    const l = moveTab(two, "c", "p0");
    expect(shape(l)).toEqual([["a", "b", "c"]]);
    expect(l.root.kind).toBe("pane");
    expect(l.focus).toBe("p0");
  });

  it("clamps a wild index", () => {
    const l = withTabs("a", "b", "c");
    expect(shape(moveTab(l, "a", "p0", 99))).toEqual([["b", "c", "a"]]);
    expect(shape(moveTab(l, "c", "p0", -5))).toEqual([["c", "a", "b"]]);
    expect(shape(moveTab(l, "a", "p0", Number.NaN))).toEqual([["b", "c", "a"]]);
  });

  it("ignores unknown tabs and panes", () => {
    const l = withTabs("a");
    expect(moveTab(l, "zz", "p0")).toBe(l);
    expect(moveTab(l, "a", "nope")).toBe(l);
  });

});

describe("splitting", () => {
  it("the new pane holds the tab, shows it and takes the focus", () => {
    const l = splitWithTab(withTabs("a", "b"), "b", "p0", "right");
    expect(shape(l)).toEqual([["a"], ["b"]]);
    expect(activeTab(l)).toBe("b");
    expect(l.root.kind === "split" && l.root.dir).toBe("row");
    // The pane it left shows its neighbour.
    expect(shownTabs(l)).toEqual(["a", "b"]);
    // The next tab opens in the pane in focus — the new one.
    expect(shape(addTab(l, "c"))).toEqual([["a"], ["b", "c"]]);
  });

  it("puts the new pane on the side asked for", () => {
    const at = (edge: Edge) => shape(splitWithTab(withTabs("a", "b"), "b", "p0", edge));
    expect(at("left")).toEqual([["b"], ["a"]]);
    expect(at("top")).toEqual([["b"], ["a"]]);
    expect(at("right")).toEqual([["a"], ["b"]]);
    expect(at("bottom")).toEqual([["a"], ["b"]]);
    const dir = (edge: Edge) => {
      const root = splitWithTab(withTabs("a", "b"), "b", "p0", edge).root;
      return root.kind === "split" ? root.dir : null;
    };
    expect(dir("left")).toBe("row");
    expect(dir("bottom")).toBe("col");
  });

  it("a pane's only tab cannot be split off its own pane", () => {
    const l = withTabs("a");
    expect(splitWithTab(l, "a", "p0", "right")).toBe(l);
    expect(splitWithTab(l, "zz", "p0", "right")).toBe(l);
    expect(splitWithTab(withTabs("a", "b"), "a", "nope", "right")).toEqual(withTabs("a", "b"));
  });

  it("a tab split onto another pane's edge leaves its own pane", () => {
    const two = twoPanes(); // [a b] | [c]
    const right = panes(two)[1].id;
    const l = splitWithTab(two, "a", right, "bottom");
    expect(shape(l)).toEqual([["b"], ["c"], ["a"]]);
    expect(activeTab(l)).toBe("a");
    expect(layoutProblems(l, ["a", "b", "c"])).toEqual([]);
  });

  it("joining the panes keeps every tab and the one in focus", () => {
    const two = focusPane(twoPanes(), "p0"); // [a b*] | [c]
    const l = joinPanes(two);
    expect(shape(l)).toEqual([["a", "b", "c"]]);
    expect(activeTab(l)).toBe("b");
    expect(joinPanes(l)).toBe(l);
  });
});

describe("ratios", () => {
  it("are clamped, and junk becomes a half", () => {
    expect(clampRatio(0)).toBe(RATIO_MIN);
    expect(clampRatio(2)).toBe(RATIO_MAX);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });

  it("setRatio changes the named split only", () => {
    const two = twoPanes();
    const id = two.root.id;
    const l = setRatio(two, id, 0.3);
    expect(l.root.kind === "split" && l.root.ratio).toBe(0.3);
    expect(setRatio(l, id, 0.3)).toBe(l);
    expect(setRatio(l, "nope", 0.7)).toBe(l);
  });

  it("reaches a nested split", () => {
    const two = twoPanes();
    const right = panes(two)[1].id;
    const three = splitWithTab(two, "a", right, "bottom");
    const inner = three.root.kind === "split" ? three.root.b : null;
    expect(inner?.kind).toBe("split");
    const l = setRatio(three, (inner as LayoutNode).id, 0.25);
    const after = l.root.kind === "split" ? l.root.b : null;
    expect(after?.kind === "split" && after.ratio).toBe(0.25);
  });
});

describe("rectangles", () => {
  const lim = { minW: 100, minH: 50, gap: 2 };

  it("one pane fills the bounds", () => {
    const { panes: rects, dividers } = layoutRects(withTabs("a").root, { width: 800, height: 600 });
    expect(rects.p0).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(dividers).toEqual([]);
  });

  it("a row split shares the width around the divider", () => {
    const two = twoPanes();
    const [left, right] = panes(two);
    const { panes: rects, dividers } = layoutRects(two.root, { width: 802, height: 600 }, lim);
    expect(rects[left.id]).toEqual({ x: 0, y: 0, w: 400, h: 600 });
    expect(rects[right.id]).toEqual({ x: 402, y: 0, w: 400, h: 600 });
    expect(dividers).toHaveLength(1);
    expect(dividers[0].rect).toEqual({ x: 400, y: 0, w: 2, h: 600 });
    expect(dividers[0].ratio).toBeCloseTo(0.5);
    expect(dividers[0].min).toBeCloseTo(100 / 800);
    expect(dividers[0].max).toBeCloseTo(1 - 100 / 800);
  });

  it("a column split shares the height", () => {
    const l = splitWithTab(withTabs("a", "b"), "b", "p0", "bottom");
    const [top, bottom] = panes(l);
    const { panes: rects, dividers } = layoutRects(l.root, { width: 400, height: 302 }, lim);
    expect(rects[top.id]).toEqual({ x: 0, y: 0, w: 400, h: 150 });
    expect(rects[bottom.id]).toEqual({ x: 0, y: 152, w: 400, h: 150 });
    expect(dividers[0].dir).toBe("col");
  });

  it("no pane is drawn under the minimum while the space allows", () => {
    const squeezed = setRatio(twoPanes(), twoPanes().root.id, RATIO_MIN);
    const [left] = panes(squeezed);
    const { panes: rects } = layoutRects(squeezed.root, { width: 802, height: 600 }, lim);
    expect(rects[left.id].w).toBe(100);
  });

  it("a nested split counts the minimum of every pane along the axis", () => {
    // [a] | ([b] | [c]) — the right half needs two minimums and a gap.
    let l = splitWithTab(withTabs("a", "b", "c"), "b", "p0", "right");
    l = splitWithTab(l, "c", l.focus, "right");
    l = setRatio(l, l.root.id, RATIO_MAX);
    const all = panes(l);
    const { panes: rects } = layoutRects(l.root, { width: 604, height: 400 }, lim);
    expect(rects[all[1].id].w).toBeGreaterThanOrEqual(100);
    expect(rects[all[2].id].w).toBeGreaterThanOrEqual(100);
  });

  it("with no room for the minimums the halves shrink in proportion", () => {
    const two = twoPanes();
    const [left, right] = panes(two);
    const { panes: rects, dividers } = layoutRects(two.root, { width: 102, height: 100 }, lim);
    expect(rects[left.id].w).toBe(50);
    expect(rects[right.id].w).toBe(50);
    // Nothing to drag towards: the range collapses onto what is drawn.
    expect(dividers[0].min).toBe(dividers[0].max);
  });

  it("survives zero and negative bounds", () => {
    const two = twoPanes();
    const { panes: rects } = layoutRects(two.root, { width: 0, height: -5 });
    for (const r of Object.values(rects)) {
      expect(r.w).toBeGreaterThanOrEqual(0);
      expect(r.h).toBeGreaterThanOrEqual(0);
    }
  });

  it("a divider follows the pointer inside its range", () => {
    const two = twoPanes();
    const [d] = layoutRects(two.root, { width: 802, height: 600 }, lim).dividers;
    expect(ratioAt(d, 200)).toBeCloseTo(0.25);
    expect(ratioAt(d, 0)).toBeCloseTo(d.min);
    expect(ratioAt(d, 5000)).toBeCloseTo(d.max);
    expect(nudgedRatio(d, 80)).toBeCloseTo(0.6);
    expect(ratioAt({ ...d, avail: 0 }, 300)).toBe(d.ratio);
  });

  it("says whether a pane is big enough to split", () => {
    expect(canSplit({ x: 0, y: 0, w: 202, h: 60 }, "right", lim)).toBe(true);
    expect(canSplit({ x: 0, y: 0, w: 201, h: 60 }, "left", lim)).toBe(false);
    expect(canSplit({ x: 0, y: 0, w: 500, h: 101 }, "bottom", lim)).toBe(false);
    expect(canSplit({ x: 0, y: 0, w: 500, h: 102 }, "top", lim)).toBe(true);
    expect(canSplit(undefined, "top", lim)).toBe(false);
    expect(canSplit({ x: 0, y: 0, w: 2000, h: 2000 }, "right")).toBe(true);
  });
});

describe("drop zones", () => {
  const rect = { x: 100, y: 100, w: 400, h: 200 };

  it("the middle joins the pane, an edge splits it", () => {
    expect(paneZone(rect, 300, 200)).toBe("center");
    expect(paneZone(rect, 110, 200)).toBe("left");
    expect(paneZone(rect, 490, 200)).toBe("right");
    expect(paneZone(rect, 300, 110)).toBe("top");
    expect(paneZone(rect, 300, 290)).toBe("bottom");
  });

  it("in a corner the nearer edge wins, as a share of the pane", () => {
    // 20px from the left of a 400-wide pane is 5%; 20px from the top of a
    // 200-tall one is 10% — the left edge is nearer.
    expect(paneZone(rect, 120, 120)).toBe("left");
    expect(paneZone(rect, 180, 110)).toBe("top");
  });

  it("a pane with no size has no edges", () => {
    expect(paneZone({ x: 0, y: 0, w: 0, h: 10 }, 0, 0)).toBe("center");
  });

  it("the tint covers the half the tab would take", () => {
    expect(zoneRect(rect, "center")).toEqual(rect);
    expect(zoneRect(rect, "left")).toEqual({ x: 100, y: 100, w: 200, h: 200 });
    expect(zoneRect(rect, "right")).toEqual({ x: 300, y: 100, w: 200, h: 200 });
    expect(zoneRect(rect, "top")).toEqual({ x: 100, y: 100, w: 400, h: 100 });
    expect(zoneRect(rect, "bottom")).toEqual({ x: 100, y: 200, w: 400, h: 100 });
  });
});

describe("dropping a dragged tab", () => {
  it("on a strip: a move to that slot", () => {
    const two = twoPanes();
    const right = panes(two)[1].id;
    const l = applyDrop(two, "a", { kind: "strip", pane: right, index: 1 });
    expect(shape(l)).toEqual([["b"], ["c", "a"]]);
  });

  it("on a pane's middle: joins it; on an edge: a new pane", () => {
    const two = twoPanes();
    const right = panes(two)[1].id;
    expect(shape(applyDrop(two, "a", { kind: "pane", pane: right, zone: "center" }))).toEqual([
      ["b"],
      ["c", "a"],
    ]);
    expect(shape(applyDrop(two, "a", { kind: "pane", pane: right, zone: "left" }))).toEqual([
      ["b"],
      ["a"],
      ["c"],
    ]);
  });

  it("on the body of its own pane: nothing — not 'to the end'", () => {
    const l = withTabs("a", "b", "c");
    const drop: TabDrop = { kind: "pane", pane: "p0", zone: "center" };
    expect(applyDrop(l, "a", drop)).toBe(l);
    expect(dropChanges(l, "a", drop)).toBe(false);
  });

  it("tells the same target again from another one", () => {
    const strip: TabDrop = { kind: "strip", pane: "p0", index: 1 };
    expect(sameDrop(strip, { ...strip })).toBe(true);
    expect(sameDrop(strip, { ...strip, index: 2 })).toBe(false);
    expect(sameDrop(strip, { ...strip, pane: "p1" })).toBe(false);
    const body: TabDrop = { kind: "pane", pane: "p0", zone: "left" };
    expect(sameDrop(body, { ...body })).toBe(true);
    expect(sameDrop(body, { ...body, zone: "center" })).toBe(false);
    expect(sameDrop(body, { ...body, pane: "p1" })).toBe(false);
    // A strip of a pane and that pane's body are different places.
    expect(sameDrop(strip, body)).toBe(false);
    expect(sameDrop(body, strip)).toBe(false);
    // No target is the same as no target, and as nothing else.
    expect(sameDrop(null, null)).toBe(true);
    expect(sameDrop(null, strip)).toBe(false);
    expect(sameDrop(body, null)).toBe(false);
  });

  it("tells the same rectangle again from another one", () => {
    const r = { x: 10, y: 20, w: 300, h: 200 };
    expect(sameRect(r, { ...r })).toBe(true);
    for (const key of ["x", "y", "w", "h"] as const) {
      expect(sameRect(r, { ...r, [key]: r[key] + 1 }), key).toBe(false);
    }
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(null, r)).toBe(false);
    expect(sameRect(r, null)).toBe(false);
  });

  it("offers only targets that change something", () => {
    const l = withTabs("a", "b");
    // Its own slot.
    expect(dropChanges(l, "a", { kind: "strip", pane: "p0", index: 0 })).toBe(false);
    expect(dropChanges(l, "a", { kind: "strip", pane: "p0", index: 1 })).toBe(true);
    // An edge of its own pane: fine with a second tab, pointless alone.
    expect(dropChanges(l, "a", { kind: "pane", pane: "p0", zone: "right" })).toBe(true);
    expect(dropChanges(withTabs("a"), "a", { kind: "pane", pane: "p0", zone: "right" })).toBe(false);
    // Unknown tab or pane.
    expect(dropChanges(l, "zz", { kind: "strip", pane: "p0", index: 0 })).toBe(false);
    expect(dropChanges(l, "a", { kind: "strip", pane: "nope", index: 0 })).toBe(false);
    expect(dropChanges(l, "a", { kind: "pane", pane: "nope", zone: "left" })).toBe(false);
    // Another pane's strip always changes something.
    const two = twoPanes();
    expect(dropChanges(two, "a", { kind: "strip", pane: panes(two)[1].id, index: 0 })).toBe(true);
  });

  it("the strips preview the drop: the others make room, the old place closes up", () => {
    const two = twoPanes(); // [a b] | [c]
    const right = panes(two)[1].id;
    const drop: TabDrop = { kind: "strip", pane: right, index: 0 };
    expect(previewTabs(two, right, "a", drop)).toEqual(["a", "c"]);
    expect(previewTabs(two, "p0", "a", drop)).toEqual(["b"]);
    // Nothing dragged, or the pointer over a pane's body: the committed order.
    expect(previewTabs(two, "p0", null, null)).toEqual(["a", "b"]);
    expect(previewTabs(two, "p0", "a", { kind: "pane", pane: right, zone: "left" })).toEqual([
      "a",
      "b",
    ]);
    expect(previewTabs(two, "nope", "a", drop)).toEqual([]);
  });

  it("a pane whose last tab is leaving still has a strip to draw", () => {
    const two = twoPanes();
    const right = panes(two)[1].id;
    expect(previewTabs(two, right, "c", { kind: "strip", pane: "p0", index: 0 })).toEqual([]);
    expect(previewTabs(two, "p0", "c", { kind: "strip", pane: "p0", index: 0 })).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

});

describe("a tab arriving from another window", () => {
  it("with no drop it goes where a new tab goes: the end of the pane in focus", () => {
    const two = twoPanes();
    const l = placeTab(two, "x", null);
    expect(shape(l)).toEqual([["a", "b"], ["c", "x"]]);
    expect(activeTab(l)).toBe("x");
    expect(layoutProblems(l, ["a", "b", "c", "x"])).toEqual([]);
    // The first tab of an empty centre.
    expect(shape(placeTab(emptyLayout(), "x", null))).toEqual([["x"]]);
  });

  it("on a strip: that slot of that pane, shown and in focus", () => {
    const two = twoPanes();
    const left = panes(two)[0].id;
    const l = placeTab(two, "x", { kind: "strip", pane: left, index: 1 });
    expect(shape(l)).toEqual([["a", "x", "b"], ["c"]]);
    expect(l.focus).toBe(left);
    expect(activeTab(l)).toBe("x");
    // Out of range is the end, as for a move.
    expect(shape(placeTab(two, "x", { kind: "strip", pane: left, index: 99 }))).toEqual([
      ["a", "b", "x"],
      ["c"],
    ]);
    expect(shape(placeTab(two, "x", { kind: "strip", pane: left, index: -3 }))).toEqual([
      ["x", "a", "b"],
      ["c"],
    ]);
  });

  it("on a pane's middle: joins it; on an edge: a new pane there", () => {
    const two = twoPanes();
    const left = panes(two)[0].id;
    expect(shape(placeTab(two, "x", { kind: "pane", pane: left, zone: "center" }))).toEqual([
      ["a", "b", "x"],
      ["c"],
    ]);
    const split = placeTab(two, "x", { kind: "pane", pane: left, zone: "right" });
    expect(shape(split)).toEqual([["a", "b"], ["x"], ["c"]]);
    expect(activeTab(split)).toBe("x");
    expect(layoutProblems(split, ["a", "b", "c", "x"])).toEqual([]);
  });

  it("no other pane changes what it shows", () => {
    // `[a b] | [c]`, the left pane showing `a`, the right one in focus.
    const two = activateTab(activateTab(twoPanes(), "a"), "c");
    const [left, right] = panes(two).map((p) => p.id);
    for (const drop of [
      { kind: "strip", pane: left, index: 0 },
      { kind: "pane", pane: left, zone: "center" },
      { kind: "pane", pane: left, zone: "bottom" },
      { kind: "pane", pane: right, zone: "left" },
      null,
    ] satisfies (TabDrop | null)[]) {
      const l = placeTab(two, "x", drop);
      const lands = paneOf(l, "x")!.id;
      for (const pane of panes(two)) {
        if (pane.id === lands) continue;
        expect(findPane(l, pane.id)?.active, JSON.stringify(drop)).toBe(pane.active);
      }
    }
    // "Open it, then move it" is exactly what this is not: the focused pane
    // would first show the newcomer, and fall back to a neighbour when it left.
    const viaOpen = applyDrop(addTab(activateTab(two, "a"), "x"), "x", {
      kind: "pane",
      pane: right,
      zone: "center",
    });
    expect(findPane(viaOpen, left)?.active).toBe("b");
  });

  it("the only pane there is, while it is empty, is not split", () => {
    const empty = emptyLayout();
    const l = placeTab(empty, "x", { kind: "pane", pane: empty.focus, zone: "right" });
    expect(shape(l)).toEqual([["x"]]);
    expect(layoutProblems(l, ["x"])).toEqual([]);
  });

  it("a drop naming a pane that is gone falls back to the pane in focus", () => {
    const two = twoPanes();
    expect(shape(placeTab(two, "x", { kind: "strip", pane: "nope", index: 0 }))).toEqual([
      ["a", "b"],
      ["c", "x"],
    ]);
    expect(shape(placeTab(two, "x", { kind: "pane", pane: "nope", zone: "left" }))).toEqual([
      ["a", "b"],
      ["c", "x"],
    ]);
  });

  it("a tab that is already here is shown, not added twice", () => {
    const two = twoPanes();
    const l = placeTab(two, "a", { kind: "pane", pane: panes(two)[1].id, zone: "center" });
    expect(shape(l)).toEqual([["a", "b"], ["c"]]);
    expect(activeTab(l)).toBe("a");
  });

  it("the preview keeps a place in the strip the tab would land in, and only there", () => {
    const two = twoPanes();
    const [left, right] = panes(two).map((p) => p.id);
    const strip: TabDrop = { kind: "strip", pane: left, index: 1 };
    expect(previewIncoming(two, left, "@in", strip)).toEqual(["a", "@in", "b"]);
    expect(previewIncoming(two, right, "@in", strip)).toEqual(["c"]);
    // A pane's middle: the end of its strip.
    const middle: TabDrop = { kind: "pane", pane: left, zone: "center" };
    expect(previewIncoming(two, left, "@in", middle)).toEqual(["a", "b", "@in"]);
    // Nowhere in particular: the end of the pane in focus.
    expect(previewIncoming(two, right, "@in", null)).toEqual(["c", "@in"]);
    expect(previewIncoming(two, left, "@in", null)).toEqual(["a", "b"]);
    // An edge makes a new pane: no strip on screen shows it.
    const edge: TabDrop = { kind: "pane", pane: left, zone: "top" };
    expect(previewIncoming(two, left, "@in", edge)).toEqual(["a", "b"]);
    expect(previewIncoming(two, right, "@in", edge)).toEqual(["c"]);
    // The preview is a picture: the layout itself is untouched.
    expect(shape(two)).toEqual([["a", "b"], ["c"]]);
  });

  it("what the preview shows is where the tab lands", () => {
    fc.assert(
      fc.property(
        fc.array(OP, { maxLength: 30 }),
        PANE,
        ZONE,
        fc.option(fc.integer({ min: -2, max: 8 }), { nil: null }),
        fc.constantFrom("strip", "pane", "none"),
        (ops, at, zone, index, kind) => {
          const state = { l: emptyLayout(), open: new Set<string>() };
          for (const o of ops) step(state, o);
          const all = panes(state.l);
          const pane = all[at % all.length].id;
          const drop: TabDrop | null =
            kind === "strip"
              ? { kind, pane, index: index ?? 0 }
              : kind === "pane"
                ? { kind, pane, zone }
                : null;
          const landed = placeTab(state.l, "x", drop);
          expect(layoutProblems(landed, [...state.open, "x"])).toEqual([]);
          expect(activeTab(landed)).toBe("x");
          // Every strip that was on screen shows what the preview promised.
          for (const p of all) {
            const after = findPane(landed, p.id);
            expect(after?.tabs).toEqual(previewIncoming(state.l, p.id, "x", drop));
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("layoutProblems", () => {
  it("names what is wrong", () => {
    const bad: CenterLayout = {
      focus: "gone",
      seq: 9,
      root: {
        kind: "split",
        id: "s",
        dir: "row",
        ratio: 2,
        a: { kind: "pane", id: "x", tabs: ["a"], active: "zz" },
        b: { kind: "pane", id: "x", tabs: ["a"], active: null },
      },
    };
    const problems = layoutProblems(bad, ["a", "b"]);
    expect(problems).toEqual(
      expect.arrayContaining([
        "duplicate node id x",
        "ratio out of range in s",
        "tab a is in more than one place",
        "pane x shows a tab it does not hold",
        "focus names no pane",
        "tab b is in no pane",
      ]),
    );
    expect(layoutProblems(withTabs("a"), [])).toContain("pane holds unknown tab a");
    const bare: CenterLayout = {
      focus: "x",
      seq: 3,
      root: {
        kind: "split",
        id: "s",
        dir: "col",
        ratio: 0.5,
        a: { kind: "pane", id: "x", tabs: [], active: null },
        b: { kind: "pane", id: "y", tabs: [], active: null },
      },
    };
    expect(layoutProblems(bare)).toEqual(["pane x is empty", "pane y is empty"]);
  });
});

// ── Properties ───────────────────────────────────────────────────────────────

const TAB = fc.constantFrom("a", "b", "c", "d", "e", "f");
const EDGE = fc.constantFrom<Edge>(...EDGES);
const ZONE = fc.constantFrom<PaneZone>(...EDGES, "center");
/** A pane picked by its position in reading order, so it always names a real one. */
const PANE = fc.nat({ max: 7 });

type Op =
  | { op: "open"; tab: string }
  | { op: "close"; tab: string }
  | { op: "activate"; tab: string }
  | { op: "focus"; pane: number }
  | { op: "move"; tab: string; pane: number; index: number | null }
  | { op: "splitTab"; tab: string; pane: number; edge: Edge }
  | { op: "drop"; tab: string; pane: number; zone: PaneZone }
  | { op: "join" }
  | { op: "ratio"; pane: number; ratio: number };

const OP: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("open" as const), tab: TAB }),
  fc.record({ op: fc.constant("close" as const), tab: TAB }),
  fc.record({ op: fc.constant("activate" as const), tab: TAB }),
  fc.record({ op: fc.constant("focus" as const), pane: PANE }),
  fc.record({
    op: fc.constant("move" as const),
    tab: TAB,
    pane: PANE,
    index: fc.option(fc.integer({ min: -2, max: 8 }), { nil: null }),
  }),
  fc.record({ op: fc.constant("splitTab" as const), tab: TAB, pane: PANE, edge: EDGE }),
  fc.record({ op: fc.constant("drop" as const), tab: TAB, pane: PANE, zone: ZONE }),
  fc.record({ op: fc.constant("join" as const) }),
  fc.record({
    op: fc.constant("ratio" as const),
    pane: PANE,
    ratio: fc.double({ min: -1, max: 2, noNaN: false }),
  }),
);

/** Apply one operation, tracking which tabs are open the way the store does. */
function step(state: { l: CenterLayout; open: Set<string> }, o: Op): void {
  const all = panes(state.l);
  const pane = "pane" in o ? all[o.pane % all.length].id : "";
  switch (o.op) {
    case "open":
      state.l = addTab(state.l, o.tab);
      state.open.add(o.tab);
      break;
    case "close":
      state.l = removeTab(state.l, o.tab);
      state.open.delete(o.tab);
      break;
    case "activate":
      state.l = activateTab(state.l, o.tab);
      break;
    case "focus":
      state.l = focusPane(state.l, pane);
      break;
    case "move":
      state.l = moveTab(state.l, o.tab, pane, o.index);
      break;
    case "splitTab":
      state.l = splitWithTab(state.l, o.tab, pane, o.edge);
      break;
    case "drop":
      state.l = applyDrop(state.l, o.tab, { kind: "pane", pane, zone: o.zone });
      break;
    case "join":
      state.l = joinPanes(state.l);
      break;
    case "ratio": {
      // Any split will do: take the root's when it is one.
      if (state.l.root.kind === "split") state.l = setRatio(state.l, state.l.root.id, o.ratio);
      break;
    }
  }
}

describe("properties", () => {
  it("every operation leaves a sound layout holding exactly the open tabs", () => {
    fc.assert(
      fc.property(fc.array(OP, { maxLength: 60 }), (ops) => {
        const state = { l: emptyLayout(), open: new Set<string>() };
        for (const o of ops) {
          step(state, o);
          expect(layoutProblems(state.l, [...state.open])).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("the rectangles tile the bounds: no overlap, nothing lost, every pane placed", () => {
    fc.assert(
      fc.property(
        fc.array(OP, { maxLength: 40 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 2000 }),
        (ops, width, height) => {
          const state = { l: emptyLayout(), open: new Set<string>() };
          for (const o of ops) step(state, o);
          const { panes: rects, dividers } = layoutRects(state.l.root, { width, height });
          const all = panes(state.l);
          expect(Object.keys(rects).sort()).toEqual(all.map((p) => p.id).sort());
          expect(dividers).toHaveLength(all.length - 1);
          const boxes = [...Object.values(rects), ...dividers.map((d) => d.rect)];
          let area = 0;
          for (const r of boxes) {
            expect(r.w).toBeGreaterThanOrEqual(0);
            expect(r.h).toBeGreaterThanOrEqual(0);
            expect(r.x).toBeGreaterThanOrEqual(0);
            expect(r.y).toBeGreaterThanOrEqual(0);
            expect(r.x + r.w).toBeLessThanOrEqual(width);
            expect(r.y + r.h).toBeLessThanOrEqual(height);
            area += r.w * r.h;
          }
          // Inside the bounds and summing to them means they do not overlap.
          expect(area).toBe(width * height);
          for (const d of dividers) {
            expect(d.min).toBeLessThanOrEqual(d.max + 1e-9);
            expect(d.ratio).toBeGreaterThanOrEqual(d.min - 1e-9);
            expect(d.ratio).toBeLessThanOrEqual(d.max + 1e-9);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("while the bounds allow, no pane is drawn under the minimum", () => {
    fc.assert(
      fc.property(fc.array(OP, { maxLength: 40 }), (ops) => {
        const state = { l: emptyLayout(), open: new Set<string>() };
        for (const o of ops) step(state, o);
        const n = panes(state.l).length;
        // Room for every pane's minimum along both axes, however they are split.
        const bounds = {
          width: n * (PANE_LIMITS.minW + PANE_LIMITS.gap),
          height: n * (PANE_LIMITS.minH + PANE_LIMITS.gap),
        };
        const { panes: rects } = layoutRects(state.l.root, bounds);
        for (const r of Object.values(rects)) {
          expect(r.w).toBeGreaterThanOrEqual(PANE_LIMITS.minW);
          expect(r.h).toBeGreaterThanOrEqual(PANE_LIMITS.minH);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a drop that claims to change nothing changes nothing", () => {
    fc.assert(
      fc.property(fc.array(OP, { maxLength: 30 }), TAB, PANE, ZONE, (ops, tab, at, zone) => {
        const state = { l: emptyLayout(), open: new Set<string>() };
        for (const o of ops) step(state, o);
        const all = panes(state.l);
        const drop: TabDrop = { kind: "pane", pane: all[at % all.length].id, zone };
        if (!dropChanges(state.l, tab, drop)) expect(applyDrop(state.l, tab, drop)).toBe(state.l);
      }),
    );
  });

  it("moving a tab never loses or duplicates one, and it lands where asked", () => {
    fc.assert(
      fc.property(fc.array(OP, { maxLength: 30 }), TAB, PANE, (ops, tab, at) => {
        const state = { l: emptyLayout(), open: new Set<string>() };
        for (const o of ops) step(state, o);
        if (!paneOf(state.l, tab)) return;
        const all = panes(state.l);
        const target = all[at % all.length].id;
        const before = orderedTabs(state.l).sort();
        const after = moveTab(state.l, tab, target);
        expect(orderedTabs(after).sort()).toEqual(before);
        // The target pane may itself have been the emptied one's heir; the tab is
        // in a pane that still exists, and it is the target unless that vanished.
        expect(findPane(after, target) ? paneOf(after, tab)?.id : target).toBe(target);
      }),
    );
  });
});

// ── A layout read back from storage (v1.6) ──────────────────────────────────

/** What a pane shows and holds, pane by pane — a layout without its node ids. */
const picture = (l: CenterLayout) => panes(l).map((p) => ({ tabs: p.tabs, active: p.active }));

/** Dir and ratio of every split, in the order `panes` walks the tree. */
function splits(n: LayoutNode): { dir: string; ratio: number }[] {
  return n.kind === "pane" ? [] : [{ dir: n.dir, ratio: n.ratio }, ...splits(n.a), ...splits(n.b)];
}

/** What survives a save and a load: everything but the node ids. */
const essence = (l: CenterLayout) => ({
  picture: picture(l),
  splits: splits(l.root),
  focus: panes(l).findIndex((p) => p.id === l.focus),
});

describe("a layout read back from storage", () => {
  const roundTrip = (l: CenterLayout): CenterLayout =>
    loadLayout(JSON.parse(JSON.stringify(savedLayout(l))), orderedTabs(l));

  it("comes back as it was saved: panes, order, shown tabs, ratios, focus", () => {
    let l = splitWithTab(withTabs("a", "b", "c", "d"), "d", "p0", "right");
    l = splitWithTab(l, "c", "p0", "bottom");
    l = setRatio(l, (l.root as { id: string }).id, 0.3);
    l = activateTab(l, "a");
    const back = roundTrip(l);
    expect(essence(back)).toEqual(essence(l));
    expect(layoutProblems(back, ["a", "b", "c", "d"])).toEqual([]);
  });

  it("nothing saved and nothing to restore is the empty centre", () => {
    expect(loadLayout(null, [])).toEqual(emptyLayout());
    expect(loadLayout({ root: 7, focus: [] }, [])).toEqual(emptyLayout());
  });

  it("tabs with no saved tree stand in one pane, the first shown", () => {
    const l = loadLayout(undefined, ["a", "b"]);
    expect(picture(l)).toEqual([{ tabs: ["a", "b"], active: "a" }]);
    expect(layoutProblems(l, ["a", "b"])).toEqual([]);
  });

  it("a tab that is not being restored leaves its pane, and an emptied pane goes with its split", () => {
    const saved = savedLayout(twoPanes()); // [a b] | [c]
    const l = loadLayout(saved, ["a", "b"]);
    expect(picture(l)).toEqual([{ tabs: ["a", "b"], active: "b" }]);
    expect(l.root.kind).toBe("pane");
    expect(layoutProblems(l, ["a", "b"])).toEqual([]);
  });

  it("a pane whose shown tab is gone shows its first", () => {
    const saved = savedLayout(activateTab(twoPanes(), "b")); // [a b*] | [c]
    expect(picture(loadLayout(saved, ["a", "c"]))).toEqual([
      { tabs: ["a"], active: "a" },
      { tabs: ["c"], active: "c" },
    ]);
  });

  it("focus stays with its pane, or goes to the first when that pane is gone", () => {
    const saved = savedLayout(twoPanes()); // focus on [c]
    expect(essence(loadLayout(saved, ["a", "b", "c"])).focus).toBe(1);
    expect(essence(loadLayout(saved, ["a", "b"])).focus).toBe(0);
  });

  it("a tab the tree does not mention joins the pane in focus without being shown", () => {
    const saved = savedLayout(activateTab(twoPanes(), "a")); // [a* b] | [c], focus left
    const l = loadLayout(saved, ["a", "b", "c", "x", "y"]);
    expect(picture(l)).toEqual([
      { tabs: ["a", "b", "x", "y"], active: "a" },
      { tabs: ["c"], active: "c" },
    ]);
  });

  it("a tab named twice stands once, where it is met first", () => {
    const saved = {
      focus: "q",
      root: {
        kind: "split",
        id: "s",
        dir: "row",
        ratio: 0.5,
        a: { kind: "pane", id: "p", tabs: ["a", "a", "b"], active: "a" },
        b: { kind: "pane", id: "q", tabs: ["a", "c"], active: "a" },
      },
    };
    const l = loadLayout(saved, ["a", "b", "c"]);
    expect(picture(l)).toEqual([
      { tabs: ["a", "b"], active: "a" },
      { tabs: ["c"], active: "c" },
    ]);
    expect(layoutProblems(l, ["a", "b", "c"])).toEqual([]);
  });

  it("junk in a split is brought into range: the ratio, the direction", () => {
    const pane = (id: string, tab: string) => ({ kind: "pane", id, tabs: [tab], active: tab });
    const at = (ratio: unknown, dir: unknown) =>
      loadLayout({ focus: "p", root: { kind: "split", dir, ratio, a: pane("p", "a"), b: pane("q", "b") } }, ["a", "b"]);
    expect(splits(at(7, "col").root)).toEqual([{ dir: "col", ratio: RATIO_MAX }]);
    expect(splits(at(-1, "diagonal").root)).toEqual([{ dir: "row", ratio: RATIO_MIN }]);
    expect(splits(at("half", null).root)).toEqual([{ dir: "row", ratio: 0.5 }]);
  });

  it("node ids are minted afresh, and the next pane does not collide with them", () => {
    const saved = {
      focus: "same",
      root: {
        kind: "split",
        id: "same",
        dir: "row",
        ratio: 0.5,
        a: { kind: "pane", id: "same", tabs: ["a", "b"], active: "a" },
        b: { kind: "pane", id: "same", tabs: ["c"], active: "c" },
      },
    };
    const l = loadLayout(saved, ["a", "b", "c"]);
    expect(layoutProblems(l, ["a", "b", "c"])).toEqual([]);
    const split = splitWithTab(l, "b", l.focus, "bottom");
    expect(layoutProblems(split, ["a", "b", "c"])).toEqual([]);
    expect(panes(split)).toHaveLength(3);
  });

  it("a tree nested deeper than the model ever writes keeps its tabs, in one pane", () => {
    let node: unknown = { kind: "pane", id: "deep", tabs: ["a", "b"], active: "b" };
    for (let i = 0; i < 400; i++) {
      node = { kind: "split", dir: "row", ratio: 0.5, a: node, b: { kind: "pane", tabs: [] } };
    }
    const l = loadLayout({ focus: "deep", root: node }, ["a", "b", "c"]);
    expect(layoutProblems(l, ["a", "b", "c"])).toEqual([]);
    expect(orderedTabs(l).sort()).toEqual(["a", "b", "c"]);
  });

  it("a saved layout survives the trip whatever was done to it", () => {
    fc.assert(
      fc.property(fc.array(OP, { maxLength: 40 }), (ops) => {
        const state = { l: emptyLayout(), open: new Set<string>() };
        for (const o of ops) step(state, o);
        const back = roundTrip(state.l);
        expect(layoutProblems(back, [...state.open])).toEqual([]);
        expect(essence(back)).toEqual(essence(state.l));
      }),
      { numRuns: 300 },
    );
  });

  it("whatever storage holds, the result is a sound layout of exactly the restored tabs", () => {
    const paneish = fc.record({
      kind: fc.constantFrom("pane", "tab", 3),
      id: fc.oneof(fc.constantFrom("p0", "p1", "s1"), fc.anything()),
      tabs: fc.oneof(fc.array(fc.oneof(TAB, fc.anything()), { maxLength: 6 }), fc.anything()),
      active: fc.oneof(TAB, fc.anything()),
    });
    // The leaf comes first: it is what the recursion bottoms out on.
    const junk = fc.letrec((tie) => ({
      node: fc.oneof(
        { maxDepth: 6 },
        paneish,
        fc.anything(),
        fc.record({
          kind: fc.constantFrom("split", "pane"),
          id: fc.constantFrom("s1", "p0"),
          dir: fc.constantFrom("row", "col", "x"),
          ratio: fc.oneof(fc.double(), fc.anything()),
          tabs: fc.array(TAB, { maxLength: 3 }),
          a: tie("node"),
          b: tie("node"),
        }),
      ),
    })).node;
    fc.assert(
      fc.property(
        fc.oneof(fc.record({ root: junk, focus: fc.oneof(fc.constantFrom("p0", "p1"), fc.anything()) }), fc.anything()),
        fc.uniqueArray(TAB, { maxLength: 6 }),
        (raw, tabs) => {
          const l = loadLayout(raw, tabs);
          expect(layoutProblems(l, tabs)).toEqual([]);
          // …and it is a layout the model can go on working with.
          const next = tabs.length > 0 ? removeTab(l, tabs[0]) : addTab(l, "z");
          expect(layoutProblems(next)).toEqual([]);
        },
      ),
      { numRuns: 400 },
    );
  });
});

// ── A tab that arrives with another one (v1.8) ───────────────────────────────

describe("a tab put behind another", () => {
  it("stands right after it, in its pane, and nothing on screen changes", () => {
    const l = activateTab(twoPanes(), "a"); // [a* b] | [c], focus left
    const next = addTabBehind(l, "x", "a");
    expect(panes(next).map((p) => ({ tabs: p.tabs, active: p.active }))).toEqual([
      { tabs: ["a", "x", "b"], active: "a" },
      { tabs: ["c"], active: "c" },
    ]);
    expect(next.focus).toBe(l.focus);
    expect(layoutProblems(next, ["a", "b", "c", "x"])).toEqual([]);
  });

  it("goes to the pane of the tab it came with, not to the one in focus", () => {
    const l = twoPanes(); // focus on [c]
    const next = addTabBehind(l, "x", "b");
    expect(shape(next)).toEqual([["a", "b", "x"], ["c"]]);
    expect(activeTab(next)).toBe("c");
  });

  it("with nothing to stand behind it joins the pane in focus, still unseen", () => {
    const next = addTabBehind(twoPanes(), "x", "gone");
    expect(shape(next)).toEqual([["a", "b"], ["c", "x"]]);
    expect(activeTab(next)).toBe("c");
  });

  it("is shown only when its pane showed nothing", () => {
    const next = addTabBehind(emptyLayout(), "x", "gone");
    expect(panes(next)[0]).toMatchObject({ tabs: ["x"], active: "x" });
  });

  it("a tab already in the layout is left where it is", () => {
    const l = twoPanes();
    expect(addTabBehind(l, "c", "a")).toBe(l);
  });

  it("keeps the layout sound whatever came before", () => {
    fc.assert(
      fc.property(fc.array(OP, { maxLength: 30 }), TAB, (ops, beside) => {
        const state = { l: emptyLayout(), open: new Set<string>() };
        for (const o of ops) step(state, o);
        const before = shownTabs(state.l);
        const next = addTabBehind(state.l, "doc", beside);
        expect(layoutProblems(next, [...state.open, "doc"])).toEqual([]);
        // No pane that showed a tab shows another one because of it.
        if (state.open.size > 0) expect(shownTabs(next)).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  it("before it, or at the end of its pane — for the tabs of a pane that moves whole", () => {
    const l = activateTab(twoPanes(), "a"); // [a* b] | [c]
    expect(shape(addTabBehind(l, "x", "b", "before"))).toEqual([["a", "x", "b"], ["c"]]);
    expect(shape(addTabBehind(l, "x", "a", "end"))).toEqual([["a", "b", "x"], ["c"]]);
    expect(shape(addTabBehind(l, "x", "a", "before"))).toEqual([["x", "a", "b"], ["c"]]);
    // Neither shows the newcomer nor takes the focus.
    for (const where of ["before", "end"] as const) {
      const next = addTabBehind(l, "x", "a", where);
      expect(shownTabs(next)).toEqual(shownTabs(l));
      expect(next.focus).toBe(l.focus);
    }
    // With nothing to stand next to, every side is "where a new tab goes".
    expect(shape(addTabBehind(l, "x", "gone", "before"))).toEqual([["a", "b", "x"], ["c"]]);
  });
});

// ── A pane that arrives whole (v1.10) ────────────────────────────────────────

describe("where the first tab of an arriving pane lands", () => {
  const lim = PANE_LIMITS;
  const wide = { x: 0, y: 0, w: 2 * lim.minW + lim.gap, h: lim.minH };
  const tall = { x: 0, y: 0, w: 2 * lim.minW + lim.gap - 1, h: 2 * lim.minH + lim.gap };
  const small = { x: 0, y: 0, w: lim.minW, h: lim.minH };

  it("a pane of its own beside the one in focus", () => {
    const l = withTabs("a", "b");
    expect(arrivalDrop(l, { [l.focus]: wide })).toEqual({ kind: "pane", pane: l.focus, zone: "right" });
  });

  it("below it when there is no room beside", () => {
    const l = withTabs("a");
    expect(arrivalDrop(l, { [l.focus]: tall })).toEqual({ kind: "pane", pane: l.focus, zone: "bottom" });
  });

  it("the pane in focus itself when it cannot be split, or shows nothing", () => {
    const l = withTabs("a");
    expect(arrivalDrop(l, { [l.focus]: small })).toBeNull();
    // Not measured yet — nothing to split by.
    expect(arrivalDrop(l, {})).toBeNull();
    // A window opened for the pane has one empty pane: the tab becomes its first.
    const empty = emptyLayout();
    expect(arrivalDrop(empty, { [empty.focus]: wide })).toBeNull();
  });

  it("is the pane in focus that is split, not the first one", () => {
    const l = twoPanes(); // [a b] | [c], focus on [c]
    expect(arrivalDrop(l, { [l.focus]: wide })?.pane).toBe(paneOf(l, "c")?.id);
  });

  it("what it names can be placed: the tab gets a pane of its own and is shown", () => {
    const l = withTabs("a", "b");
    const next = placeTab(l, "x", arrivalDrop(l, { [l.focus]: wide }));
    expect(shape(next)).toEqual([["a", "b"], ["x"]]);
    expect(activeTab(next)).toBe("x");
  });
});

// ── A grid of panes with one command (v1.9) ──────────────────────────────────

describe("tiling tabs into a grid of panes", () => {
  /** The tree as nested arrays: a row split is `["row", a, b]`, a pane its shown tab. */
  const sketch = (n: LayoutNode): unknown =>
    n.kind === "pane" ? n.active : [n.dir, sketch(n.a), sketch(n.b)];
  const six = () => withTabs("a", "b", "c", "d", "e", "f");

  it("gives each tab a pane of its own, `cols` to a row, in the order given", () => {
    const l = tileTabs(six(), ["a", "b", "c", "d"], 2);
    expect(panes(l).map((p) => p.active)).toEqual(["a", "b", "c", "d"]);
    expect(sketch(l.root)).toEqual(["col", ["row", "a", "b"], ["row", "c", "d"]]);
    expect(layoutProblems(l, ["a", "b", "c", "d", "e", "f"])).toEqual([]);
  });

  it("the tabs that were not asked for join the first pane, behind its tab", () => {
    const l = tileTabs(six(), ["c", "a"], 2);
    expect(panes(l).map((p) => ({ tabs: p.tabs, active: p.active }))).toEqual([
      { tabs: ["c", "b", "d", "e", "f"], active: "c" },
      { tabs: ["a"], active: "a" },
    ]);
  });

  it("the panes are equal: three in a row are thirds, three rows are thirds", () => {
    const wide = layoutRects(tileTabs(six(), ["a", "b", "c"], 3).root, { width: 902, height: 400 });
    expect(Object.values(wide.panes).map((r) => r.w)).toEqual([300, 300, 300]);
    const tall = layoutRects(tileTabs(six(), ["a", "b", "c"], 1).root, { width: 400, height: 902 });
    expect(Object.values(tall.panes).map((r) => r.h)).toEqual([300, 300, 300]);
  });

  it("a last row with fewer tabs is spread over the whole width", () => {
    const l = tileTabs(six(), ["a", "b", "c"], 2);
    expect(sketch(l.root)).toEqual(["col", ["row", "a", "b"], "c"]);
    const rects = layoutRects(l.root, { width: 801, height: 601 });
    expect(rects.panes[panes(l)[2].id].w).toBe(801);
  });

  it("the focus stays with the tab that had it, or goes to the first pane", () => {
    const start = activateTab(six(), "c");
    const kept = tileTabs(start, ["a", "b", "c"], 3);
    expect(activeTab(kept)).toBe("c");
    const moved = tileTabs(start, ["a", "b"], 2);
    expect(activeTab(moved)).toBe("a");
  });

  it("one tab asked for is one pane holding everything", () => {
    const l = tileTabs(twoPanes(), ["c"], 4);
    expect(panes(l).map((p) => p.tabs)).toEqual([["c", "a", "b"]]);
    expect(l.root.kind).toBe("pane");
  });

  it("skips tabs the layout does not hold, and does nothing when none is left", () => {
    const start = six();
    expect(panes(tileTabs(start, ["a", "zz", "b", "a"], 2)).map((p) => p.active)).toEqual(["a", "b"]);
    expect(tileTabs(start, ["zz"], 2)).toBe(start);
    expect(tileTabs(start, [], 2)).toBe(start);
  });

  it("more columns than tabs, or a column count that is junk, is as many as there are tabs — or one", () => {
    expect(sketch(tileTabs(six(), ["a", "b"], 9).root)).toEqual(["row", "a", "b"]);
    expect(sketch(tileTabs(six(), ["a", "b"], Number.NaN).root)).toEqual(["col", "a", "b"]);
    expect(sketch(tileTabs(six(), ["a", "b"], 0).root)).toEqual(["col", "a", "b"]);
  });

  it("the new nodes do not collide with what the layout makes next", () => {
    const l = tileTabs(six(), ["a", "b", "c", "d"], 2);
    const next = splitWithTab(addTab(l, "g"), "g", l.focus, "right");
    expect(layoutProblems(next, ["a", "b", "c", "d", "e", "f", "g"])).toEqual([]);
  });

  it("keeps the layout sound whatever came before, and holds exactly the same tabs", () => {
    fc.assert(
      fc.property(
        fc.array(OP, { maxLength: 30 }),
        fc.uniqueArray(TAB, { maxLength: 6 }),
        fc.integer({ min: -1, max: 6 }),
        (ops, asked, cols) => {
          const state = { l: emptyLayout(), open: new Set<string>() };
          for (const o of ops) step(state, o);
          const l = tileTabs(state.l, asked, cols);
          expect(layoutProblems(l, [...state.open])).toEqual([]);
          const tiled = asked.filter((tab) => state.open.has(tab));
          if (tiled.length > 0) {
            // Each asked-for tab is on screen, in a pane of its own.
            expect(shownTabs(l)).toEqual(tiled);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("the grid that fits", () => {
  it("holds columns times the rows that keep the pane minimum", () => {
    // 240×140 minimum, 1px between panes.
    expect(gridFit({ width: 1000, height: 600 }, 3)).toEqual({ cols: 3, panes: 12 });
    expect(gridFit({ width: 1000, height: 281 }, 3)).toEqual({ cols: 3, panes: 6 });
    expect(gridFit({ width: 1000, height: 280 }, 3)).toEqual({ cols: 3, panes: 3 });
  });

  it("gets fewer columns than asked when they would be narrower than a pane", () => {
    expect(gridFit({ width: 481, height: 300 }, 4)).toEqual({ cols: 2, panes: 4 });
    expect(gridFit({ width: 480, height: 300 }, 4)).toEqual({ cols: 1, panes: 2 });
  });

  it("is never less than one pane, whatever the room or the columns asked for", () => {
    expect(gridFit({ width: 0, height: 0 }, 4)).toEqual({ cols: 1, panes: 1 });
    expect(gridFit({ width: 1000, height: 600 }, 0)).toEqual({ cols: 1, panes: 4 });
    expect(gridFit({ width: 1000, height: 600 }, Number.NaN)).toEqual({ cols: 1, panes: 4 });
  });

  it("what it says fits does fit: no pane of such a grid goes under the minimum", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 240, max: 3000 }),
        fc.integer({ min: 140, max: 2000 }),
        fc.integer({ min: 1, max: 6 }),
        (width, height, asked) => {
          const fit = gridFit({ width, height }, asked);
          const tabs = Array.from({ length: fit.panes }, (_, i) => `t${i}`);
          const open = tabs.reduce((acc, tab) => addTab(acc, tab), emptyLayout());
          const rects = layoutRects(tileTabs(open, tabs, fit.cols).root, { width, height });
          expect(Object.keys(rects.panes)).toHaveLength(fit.panes);
          for (const r of Object.values(rects.panes)) {
            expect(r.w).toBeGreaterThanOrEqual(PANE_LIMITS.minW);
            expect(r.h).toBeGreaterThanOrEqual(PANE_LIMITS.minH);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
