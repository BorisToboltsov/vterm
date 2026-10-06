import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  activateTab,
  activeTab,
  addTab,
  applyDrop,
  canSplit,
  clampRatio,
  dropChanges,
  EDGES,
  emptyLayout,
  findPane,
  focusPane,
  focusedPane,
  joinPanes,
  layoutProblems,
  layoutRects,
  moveTab,
  moveTabFlat,
  neighbourPane,
  nudgedRatio,
  orderedTabs,
  PANE_LIMITS,
  paneOf,
  panes,
  paneZone,
  previewFlat,
  previewTabs,
  RATIO_MAX,
  RATIO_MIN,
  ratioAt,
  removeTab,
  setRatio,
  shownTabs,
  splitWithTab,
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

  it("the single strip maps a position among all tabs back to a pane", () => {
    const two = twoPanes(); // [a b] | [c]
    // Past `c`: after c, in c's pane.
    expect(shape(moveTabFlat(two, "a", 2))).toEqual([["b"], ["c", "a"]]);
    // To the very front: before the first tab.
    expect(shape(moveTabFlat(two, "c", 0))).toEqual([["c", "a", "b"]]);
    // Between b and c the tab stays next to the one before it.
    expect(shape(moveTabFlat(two, "a", 1))).toEqual([["b", "a"], ["c"]]);
    expect(moveTabFlat(withTabs("a"), "a", 0)).toEqual(withTabs("a"));
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
    // The single strip.
    expect(dropChanges(two, "a", { kind: "flat", index: 0 })).toBe(false);
    expect(dropChanges(two, "a", { kind: "flat", index: 2 })).toBe(true);
    expect(shape(applyDrop(two, "a", { kind: "flat", index: 2 }))).toEqual([["b"], ["c", "a"]]);
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

  it("the single strip previews a flat reorder", () => {
    const two = twoPanes();
    expect(previewFlat(two, null, null)).toEqual(["a", "b", "c"]);
    expect(previewFlat(two, "a", { kind: "flat", index: 2 })).toEqual(["b", "c", "a"]);
    expect(previewFlat(two, "a", { kind: "pane", pane: "p0", zone: "left" })).toEqual([
      "a",
      "b",
      "c",
    ]);
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
  | { op: "flat"; tab: string; index: number }
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
  fc.record({ op: fc.constant("flat" as const), tab: TAB, index: fc.integer({ min: -2, max: 8 }) }),
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
    case "flat":
      state.l = moveTabFlat(state.l, o.tab, o.index);
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
