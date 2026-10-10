import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  availablePanels,
  BOTTOM_MAX_SHARE,
  canHidePanel,
  clamp,
  clampSize,
  defaultDocks,
  DOCK_BOUNDS,
  DOCK_SIDES,
  dockOf,
  dropChanges,
  effectiveSize,
  HIDEABLE_PANELS,
  insertionIndex,
  isDockSide,
  isPanelId,
  isPanelShown,
  isSessionPanel,
  LAYOUT_VERSION,
  loadDocks,
  movePanel,
  offeredPanels,
  PANEL_IDS,
  persistedLayout,
  previewPanels,
  revealPanel,
  sameTarget,
  sanitizeDocks,
  sanitizeHiddenPanels,
  shownPanel,
  withPanelHidden,
  type Docks,
  type DockSide,
  type PanelId,
} from "./docklayout";

/** Every panel sits in exactly one dock — the model's one structural invariant. */
function expectWellFormed(docks: Docks) {
  const all = DOCK_SIDES.flatMap((side) => docks[side].panels);
  expect([...all].sort()).toEqual([...PANEL_IDS].sort());
  for (const side of DOCK_SIDES) {
    const d = docks[side];
    if (d.panels.length === 0) expect(d.active).toBeNull();
    else expect(d.panels).toContain(d.active);
    expect(d.size).toBeGreaterThanOrEqual(DOCK_BOUNDS[side].min);
    expect(d.size).toBeLessThanOrEqual(DOCK_BOUNDS[side].max);
    expect(typeof d.collapsed).toBe("boolean");
  }
}

describe("guards and bounds", () => {
  it("recognises panel ids and dock sides", () => {
    expect(isPanelId("docker")).toBe(true);
    expect(isPanelId("terminal")).toBe(false);
    expect(isPanelId(3)).toBe(false);
    expect(isDockSide("bottom")).toBe(true);
    expect(isDockSide("top")).toBe(false);
  });

  it("treats only the server tree as a global panel", () => {
    expect(isSessionPanel("servers")).toBe(false);
    for (const id of PANEL_IDS.filter((p) => p !== "servers")) expect(isSessionPanel(id)).toBe(true);
  });

  it("clamps values and dock sizes", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
    expect(clampSize("left", 9999)).toBe(DOCK_BOUNDS.left.max);
    expect(clampSize("right", 1)).toBe(DOCK_BOUNDS.right.min);
    expect(clampSize("bottom", 300.6)).toBe(301);
  });

  it("caps the drawn height of the bottom dock to a share of the window", () => {
    expect(effectiveSize("bottom", 700, 800)).toBe(Math.floor(800 * BOTTOM_MAX_SHARE));
    expect(effectiveSize("bottom", 200, 800)).toBe(200);
    // A tiny window still leaves the dock its minimum rather than a sliver.
    expect(effectiveSize("bottom", 400, 100)).toBe(DOCK_BOUNDS.bottom.min);
    // Unknown viewport (0 before the first measure) — draw the stored size.
    expect(effectiveSize("bottom", 400, 0)).toBe(400);
    // Side docks are never capped here.
    expect(effectiveSize("right", 700, 400)).toBe(700);
  });
});

describe("defaultDocks", () => {
  it("puts the tree left, files/git/AI right and Docker/k8s at the bottom", () => {
    const d = defaultDocks();
    expect(d.left.panels).toEqual(["servers"]);
    expect(d.right.panels).toEqual(["files", "git", "ai"]);
    expect(d.bottom.panels).toEqual(["docker", "k8s"]);
    expect(d.left.collapsed).toBe(false);
    expect(d.right.collapsed).toBe(true);
    expect(d.bottom.collapsed).toBe(true);
    expectWellFormed(d);
  });

  it("returns a fresh object every time", () => {
    const a = defaultDocks();
    a.left.panels.push("ai");
    expect(defaultDocks().left.panels).toEqual(["servers"]);
  });
});

describe("sanitizeDocks", () => {
  it("keeps a valid layout as it is", () => {
    const d = defaultDocks();
    d.left.panels = ["servers", "docker"];
    d.bottom.panels = ["k8s"];
    d.bottom.active = "k8s";
    d.left.active = "docker";
    d.bottom.collapsed = false;
    d.bottom.size = 333;
    expect(sanitizeDocks(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it("drops unknown panels and duplicates, keeping the first occurrence", () => {
    const d = sanitizeDocks({
      left: { panels: ["servers", "nope", "git"] },
      right: { panels: ["git", "files", "files", 7] },
      bottom: { panels: ["docker", "k8s", "ai"] },
    });
    expect(d.left.panels).toEqual(["servers", "git"]);
    expect(d.right.panels).toEqual(["files"]);
    expect(d.bottom.panels).toEqual(["docker", "k8s", "ai"]);
    expectWellFormed(d);
  });

  it("puts a missing panel back into its default dock", () => {
    // A layout saved before a panel existed must not lose that panel.
    const d = sanitizeDocks({
      left: { panels: ["servers"] },
      right: { panels: ["files"] },
      bottom: { panels: [] },
    });
    expect(d.right.panels).toEqual(["files", "git", "ai"]);
    expect(d.bottom.panels).toEqual(["docker", "k8s"]);
    expectWellFormed(d);
  });

  it("repairs an active tab that is not in its dock", () => {
    const d = sanitizeDocks({
      left: { panels: ["servers"], active: "docker" },
      right: { panels: ["files", "git", "ai"], active: "git" },
      bottom: { panels: ["docker", "k8s"], active: 42 },
    });
    expect(d.left.active).toBe("servers");
    expect(d.right.active).toBe("git");
    expect(d.bottom.active).toBe("docker");
  });

  it("clamps sizes and falls back on non-numbers", () => {
    const d = sanitizeDocks({
      left: { size: 99999 },
      right: { size: "wide" },
      bottom: { size: Number.NaN },
    });
    expect(d.left.size).toBe(DOCK_BOUNDS.left.max);
    expect(d.right.size).toBe(DOCK_BOUNDS.right.initial);
    expect(d.bottom.size).toBe(DOCK_BOUNDS.bottom.initial);
  });

  it("takes collapsed only as a boolean", () => {
    const d = sanitizeDocks({ left: { collapsed: "yes" }, right: { collapsed: false } });
    expect(d.left.collapsed).toBe(false); // default for left
    expect(d.right.collapsed).toBe(false);
    expect(d.bottom.collapsed).toBe(true); // default for bottom
  });

  it("survives garbage of any shape", () => {
    for (const raw of [null, undefined, 1, "x", [], { left: [] }, { left: null, right: 3 }]) {
      expectWellFormed(sanitizeDocks(raw));
    }
  });

  it("always yields every panel exactly once, whatever it is fed", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        expectWellFormed(sanitizeDocks(raw));
      }),
    );
  });

  it("is idempotent", () => {
    const side = fc.record(
      {
        panels: fc.array(fc.constantFrom(...PANEL_IDS, "bogus")),
        active: fc.constantFrom(...PANEL_IDS, null),
        size: fc.oneof(fc.integer({ min: -100, max: 5000 }), fc.constant("x")),
        collapsed: fc.boolean(),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.record({ left: side, right: side, bottom: side }), (raw) => {
        const once = sanitizeDocks(raw);
        expect(sanitizeDocks(JSON.parse(JSON.stringify(once)))).toEqual(once);
      }),
    );
  });
});

describe("loadDocks", () => {
  it("starts from defaults when nothing usable is stored", () => {
    for (const raw of [null, undefined, "x", [], {}, { unrelated: 1 }]) {
      expect(loadDocks(raw)).toEqual(defaultDocks());
    }
  });

  it("sanitizes a current layout", () => {
    const stored = persistedLayout(movePanel(defaultDocks(), "docker", "left"));
    expect(stored.version).toBe(LAYOUT_VERSION);
    const d = loadDocks(JSON.parse(JSON.stringify(stored)));
    expect(d.left.panels).toEqual(["servers", "docker"]);
    expectWellFormed(d);
  });

  it("migrates a pre-1.1 layout: widths, left collapse and the tab that was open", () => {
    const d = loadDocks({ leftWidth: 300, leftCollapsed: true, sftpWidth: 500, dockTab: "git" });
    expect(d.left.size).toBe(300);
    expect(d.left.collapsed).toBe(true);
    expect(d.right.size).toBe(500);
    expect(d.right.active).toBe("git");
    // The right dock always started collapsed before 1.1; the new docks do too.
    expect(d.right.collapsed).toBe(true);
    expect(d.bottom.panels).toEqual(["docker", "k8s"]);
    expectWellFormed(d);
  });

  it("migrates an open Docker tab to the dock Docker now lives in", () => {
    const d = loadDocks({ dockTab: "docker" });
    expect(d.bottom.active).toBe("docker");
    expect(d.right.active).toBe("files");
  });

  it("clamps out-of-range legacy widths and ignores junk", () => {
    const d = loadDocks({ leftWidth: 9999, sftpWidth: 1, dockTab: "nope" });
    expect(d.left.size).toBe(DOCK_BOUNDS.left.max);
    expect(d.right.size).toBe(DOCK_BOUNDS.right.min);
    expect(d.right.active).toBe("files");
    expect(loadDocks({ leftWidth: "x", sftpWidth: null }).left.size).toBe(DOCK_BOUNDS.left.initial);
  });

  it("round-trips through persistedLayout without sharing arrays", () => {
    const docks = defaultDocks();
    const stored = persistedLayout(docks);
    stored.docks.left.panels.push("ai");
    expect(docks.left.panels).toEqual(["servers"]);
  });
});

describe("dockOf", () => {
  it("finds the dock a panel is in", () => {
    const d = defaultDocks();
    expect(dockOf(d, "servers")).toBe("left");
    expect(dockOf(d, "ai")).toBe("right");
    expect(dockOf(d, "k8s")).toBe("bottom");
  });

  it("falls back to the default dock for a panel a broken layout lost", () => {
    const d = defaultDocks();
    d.bottom.panels = [];
    expect(dockOf(d, "docker")).toBe("bottom");
  });
});

describe("movePanel", () => {
  it("moves a panel to the end of another dock, shows it and opens the dock", () => {
    const before = defaultDocks();
    const d = movePanel(before, "docker", "right");
    expect(d.right.panels).toEqual(["files", "git", "ai", "docker"]);
    expect(d.bottom.panels).toEqual(["k8s"]);
    expect(d.right.active).toBe("docker");
    expect(d.right.collapsed).toBe(false);
    expectWellFormed(d);
    // Pure: the input is untouched.
    expect(before).toEqual(defaultDocks());
  });

  it("inserts at the requested index", () => {
    const d = movePanel(defaultDocks(), "k8s", "right", 1);
    expect(d.right.panels).toEqual(["files", "k8s", "git", "ai"]);
  });

  it("clamps an out-of-range index", () => {
    expect(movePanel(defaultDocks(), "k8s", "right", 99).right.panels).toEqual([
      "files",
      "git",
      "ai",
      "k8s",
    ]);
    expect(movePanel(defaultDocks(), "k8s", "right", -5).right.panels[0]).toBe("k8s");
  });

  it("hands the source dock's focus to the neighbour that took the slot", () => {
    const start = defaultDocks();
    start.right.active = "git";
    const d = movePanel(start, "git", "bottom");
    expect(d.right.panels).toEqual(["files", "ai"]);
    expect(d.right.active).toBe("ai");
    // Moving the last tab falls back to the previous one.
    const e = movePanel({ ...d, right: { ...d.right, active: "ai" } }, "ai", "left");
    expect(e.right.active).toBe("files");
  });

  it("leaves the source dock's active tab alone when another tab moves", () => {
    const d = movePanel(defaultDocks(), "ai", "left");
    expect(d.right.active).toBe("files");
  });

  it("empties a dock down to a null active tab", () => {
    let d = movePanel(defaultDocks(), "docker", "right");
    d = movePanel(d, "k8s", "right");
    expect(d.bottom.panels).toEqual([]);
    expect(d.bottom.active).toBeNull();
    expectWellFormed(d);
  });

  it("reorders inside a dock, reading the index against the visible list", () => {
    // files | git | ai → drop "files" on the gap after "git" (index 2).
    const d = movePanel(defaultDocks(), "files", "right", 2);
    expect(d.right.panels).toEqual(["git", "files", "ai"]);
    // …and "ai" on the gap before "files" (index 0).
    expect(movePanel(defaultDocks(), "ai", "right", 0).right.panels).toEqual([
      "ai",
      "files",
      "git",
    ]);
    // No index = to the end.
    expect(movePanel(defaultDocks(), "files", "right").right.panels).toEqual([
      "git",
      "ai",
      "files",
    ]);
  });

  it("returns the same object when the drop changes nothing", () => {
    const d = defaultDocks();
    // Onto its own slot — either gap around the tab.
    expect(movePanel(d, "git", "right", 1)).toBe(d);
    expect(movePanel(d, "git", "right", 2)).toBe(d);
    expect(movePanel(d, "ai", "right")).toBe(d);
    expect(dropChanges(d, "git", { side: "right", index: 1 })).toBe(false);
    expect(dropChanges(d, "git", { side: "bottom", index: null })).toBe(true);
  });

  it("tells the same drop target again from another one", () => {
    expect(sameTarget({ side: "right", index: 1 }, { side: "right", index: 1 })).toBe(true);
    expect(sameTarget({ side: "right", index: null }, { side: "right", index: null })).toBe(true);
    expect(sameTarget({ side: "right", index: 1 }, { side: "right", index: 2 })).toBe(false);
    expect(sameTarget({ side: "right", index: 1 }, { side: "bottom", index: 1 })).toBe(false);
    // "At the end" is not "at slot 0".
    expect(sameTarget({ side: "right", index: null }, { side: "right", index: 0 })).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(null, { side: "left", index: null })).toBe(false);
    expect(sameTarget({ side: "left", index: null }, null)).toBe(false);
  });

  it("keeps every panel exactly once across any sequence of moves", () => {
    const move = fc.record({
      panel: fc.constantFrom<PanelId>(...PANEL_IDS),
      to: fc.constantFrom<DockSide>(...DOCK_SIDES),
      index: fc.option(fc.integer({ min: -3, max: 9 }), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(move, { maxLength: 30 }), (moves) => {
        let d = defaultDocks();
        for (const m of moves) {
          d = movePanel(d, m.panel, m.to, m.index);
          expectWellFormed(d);
          expect(dockOf(d, m.panel)).toBe(m.to);
        }
      }),
    );
  });
});

describe("revealPanel", () => {
  it("opens the panel's dock on that panel", () => {
    const d = revealPanel(defaultDocks(), "ai");
    expect(d.right.active).toBe("ai");
    expect(d.right.collapsed).toBe(false);
    // Other docks are untouched.
    expect(d.bottom.collapsed).toBe(true);
  });

  it("returns the same object when the panel is already on screen", () => {
    const d = revealPanel(defaultDocks(), "servers");
    expect(revealPanel(d, "servers")).toBe(d);
  });
});

describe("what a dock shows", () => {
  it("offers session panels only while there is a session", () => {
    const d = movePanel(defaultDocks(), "docker", "left");
    expect(availablePanels(d.left, true)).toEqual(["servers", "docker"]);
    expect(availablePanels(d.left, false)).toEqual(["servers"]);
    expect(availablePanels(d.right, false)).toEqual([]);
  });

  it("falls back to an available tab without rewriting the stored one", () => {
    const d = movePanel(defaultDocks(), "docker", "left");
    expect(d.left.active).toBe("docker");
    expect(shownPanel(d.left, true)).toBe("docker");
    expect(shownPanel(d.left, false)).toBe("servers");
    expect(d.left.active).toBe("docker");
    expect(shownPanel(d.right, false)).toBeNull();
  });

  it("reports a panel as shown only when its dock is open on it", () => {
    let d = defaultDocks();
    expect(isPanelShown(d, "git", true)).toBe(false); // right dock collapsed
    d = revealPanel(d, "git");
    expect(isPanelShown(d, "git", true)).toBe(true);
    expect(isPanelShown(d, "files", true)).toBe(false);
    expect(isPanelShown(d, "git", false)).toBe(false); // no session, no panel
  });
});

describe("insertionIndex", () => {
  it("drops before a tab in its first half and after it in the second", () => {
    // A tab occupying 100…200 along the strip, at index 2.
    expect(insertionIndex(110, 100, 100, 2)).toBe(2);
    expect(insertionIndex(149, 100, 100, 2)).toBe(2);
    expect(insertionIndex(150, 100, 100, 2)).toBe(3);
    expect(insertionIndex(199, 100, 100, 2)).toBe(3);
  });
});

describe("hidden panels", () => {
  it("lets every panel be hidden except the server tree", () => {
    expect(HIDEABLE_PANELS).toEqual(["files", "git", "docker", "k8s", "ai"]);
    expect(canHidePanel("docker")).toBe(true);
    expect(canHidePanel("servers")).toBe(false);
  });

  it("sanitizes a stored list: known, hideable, each once", () => {
    expect(sanitizeHiddenPanels(["docker", "nope", "docker", "servers", 7, "ai"])).toEqual([
      "docker",
      "ai",
    ]);
    for (const raw of [null, undefined, "docker", { docker: true }, 3]) {
      expect(sanitizeHiddenPanels(raw)).toEqual([]);
    }
  });

  it("never lets the server tree into the list, whatever it is fed", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const out = sanitizeHiddenPanels(raw);
        expect(out).not.toContain("servers");
        expect(new Set(out).size).toBe(out.length);
        for (const id of out) expect(HIDEABLE_PANELS).toContain(id);
      }),
    );
  });

  it("adds and removes a panel without duplicates", () => {
    expect(withPanelHidden([], "docker", true)).toEqual(["docker"]);
    expect(withPanelHidden(["docker"], "docker", true)).toEqual(["docker"]);
    expect(withPanelHidden(["docker", "ai"], "docker", false)).toEqual(["ai"]);
    // The server tree cannot be hidden — asking changes nothing.
    expect(withPanelHidden(["ai"], "servers", true)).toEqual(["ai"]);
  });

  it("does not offer a hidden panel, with or without a session", () => {
    const d = defaultDocks();
    expect(availablePanels(d.right, true, ["git"])).toEqual(["files", "ai"]);
    expect(offeredPanels(["servers", "docker"], false, [])).toEqual(["servers"]);
    expect(offeredPanels(["servers", "docker"], true, ["docker"])).toEqual(["servers"]);
  });

  it("keeps a hidden panel's place, so it comes back where it was", () => {
    const d = defaultDocks();
    // Hiding is a filter, not a move: the dock's list is untouched.
    expect(availablePanels(d.right, true, ["git"])).not.toContain("git");
    expect(d.right.panels).toEqual(["files", "git", "ai"]);
    expect(availablePanels(d.right, true, [])).toEqual(["files", "git", "ai"]);
  });

  it("falls back to another tab when the shown one is hidden, and leaves the stored one", () => {
    const d = revealPanel(defaultDocks(), "git");
    expect(shownPanel(d.right, true, ["git"])).toBe("files");
    expect(d.right.active).toBe("git");
    expect(isPanelShown(d, "git", true, ["git"])).toBe(false);
    expect(isPanelShown(d, "files", true, ["git"])).toBe(true);
  });

  it("leaves a dock with nothing to show when all its panels are hidden", () => {
    const d = defaultDocks();
    expect(availablePanels(d.bottom, true, ["docker", "k8s"])).toEqual([]);
    expect(shownPanel(d.bottom, true, ["docker", "k8s"])).toBeNull();
  });
});

describe("previewPanels", () => {
  it("is the current order while the tab is over nothing", () => {
    const d = defaultDocks();
    expect(previewPanels(d, "docker", null)).toEqual({
      left: ["servers"],
      right: ["files", "git", "ai"],
      bottom: ["docker", "k8s"],
    });
  });

  it("opens a slot in the dock under the pointer and closes the one it left", () => {
    const d = defaultDocks();
    expect(previewPanels(d, "docker", { side: "right", index: 1 })).toEqual({
      left: ["servers"],
      right: ["files", "docker", "git", "ai"],
      bottom: ["k8s"],
    });
  });

  it("reorders inside one dock", () => {
    const d = defaultDocks();
    expect(previewPanels(d, "files", { side: "right", index: 2 }).right).toEqual([
      "git",
      "files",
      "ai",
    ]);
  });

  it("is only an order — the layout itself is not touched", () => {
    const d = defaultDocks();
    previewPanels(d, "docker", { side: "right", index: 0 });
    expect(d).toEqual(defaultDocks());
    // A preview must not open the collapsed dock it passes over.
    expect(d.right.collapsed).toBe(true);
  });
});
