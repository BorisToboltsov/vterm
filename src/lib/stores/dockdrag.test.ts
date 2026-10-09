import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPanelDrag,
  cancelPanelDrag,
  consumeDragClick,
  dockDrag,
  dockDropAt,
} from "./dockdrag.svelte";
import { layout, resetLayout } from "./layout.svelte";

// jsdom has no layout: `elementFromPoint` is supplied per test, and a tab's
// rectangle is whatever the test says it is.
function rect(el: HTMLElement, r: Partial<DOMRect>) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, ...r }) as DOMRect;
}

/**
 * Give an element a layout position distinct from where it is drawn — what a tab
 * has while it slides to a new slot. jsdom has no layout, so `offsetParent` and
 * the offsets are supplied; the parent sits at the viewport origin.
 */
function laidOut(el: HTMLElement, box: { left: number; top: number; width: number; height: number }) {
  const parent = document.body;
  parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
  Object.defineProperties(el, {
    offsetParent: { value: parent, configurable: true },
    offsetLeft: { value: box.left, configurable: true },
    offsetTop: { value: box.top, configurable: true },
    offsetWidth: { value: box.width, configurable: true },
    offsetHeight: { value: box.height, configurable: true },
  });
}

/** A dock with a horizontal strip of tabs (or a vertical rail), as Dock.svelte marks it. */
function dock(side: string, axis: "x" | "y", tabs: number[]) {
  document.body.innerHTML = `
    <div data-dock-drop="${side}" id="dock">
      <div data-dock-axis="${axis}">
        ${tabs.map((i) => `<button data-dock-tab="${i}" id="tab${i}"><span id="in${i}"></span></button>`).join("")}
      </div>
      <div id="body"></div>
    </div>
    <div id="outside"></div>`;
}

const at = (id: string) => (document.elementFromPoint = () => document.getElementById(id));

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, button: 0, bubbles: true });

/** A press on a tab element, the way a dock's `onpointerdown` hands it over. */
function press(el: HTMLElement, x = 10, y = 10) {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  const e = pointer("pointerdown", x, y);
  Object.defineProperty(e, "currentTarget", { value: el });
  return e;
}

beforeEach(() => {
  localStorage.clear();
  cancelPanelDrag();
  resetLayout();
  flushSync();
});

afterEach(() => {
  cancelPanelDrag();
  document.body.innerHTML = "";
});

describe("dockDropAt", () => {
  it("is null over anything that is not a dock", () => {
    dock("right", "x", [0]);
    at("outside");
    expect(dockDropAt(5, 5)).toBeNull();
    document.elementFromPoint = () => null;
    expect(dockDropAt(5, 5)).toBeNull();
  });

  it("appends when the pointer is over the dock but not over a tab", () => {
    dock("bottom", "x", [0, 1]);
    at("body");
    expect(dockDropAt(5, 5)).toEqual({ side: "bottom", index: null });
  });

  it("picks the gap before or after a tab by the half the pointer is in", () => {
    dock("right", "x", [0, 1, 2]);
    rect(document.getElementById("tab1")!, { left: 100, width: 80 });
    at("in1"); // a child of the tab — the hit lands on the label, not the button
    expect(dockDropAt(110, 0)).toEqual({ side: "right", index: 1 });
    expect(dockDropAt(170, 0)).toEqual({ side: "right", index: 2 });
  });

  it("measures a collapsed dock's rail along the vertical axis", () => {
    dock("left", "y", [0, 1]);
    rect(document.getElementById("tab1")!, { top: 200, height: 60, left: 0, width: 30 });
    at("tab1");
    expect(dockDropAt(15, 210)).toEqual({ side: "left", index: 1 });
    expect(dockDropAt(15, 250)).toEqual({ side: "left", index: 2 });
  });

  it("ignores a side it does not know and a tab without an index", () => {
    document.body.innerHTML = `<div data-dock-drop="top" id="d"></div>`;
    at("d");
    expect(dockDropAt(1, 1)).toBeNull();
    document.body.innerHTML = `<div data-dock-drop="right"><button data-dock-tab="x" id="t"></button></div>`;
    rect(document.getElementById("t")!, { left: 0, width: 50 });
    at("t");
    expect(dockDropAt(1, 1)).toEqual({ side: "right", index: null });
  });

  it("matches a tab by its slot along the strip, wherever the pointer is across it", () => {
    // Over the dock's body, under the second tab: the gap opens next to that tab —
    // a tab strip is a thin target, the dock under it is a big one.
    dock("right", "x", [0, 1, 2]);
    rect(document.getElementById("tab1")!, { left: 100, top: 0, width: 80, height: 30 });
    at("body");
    expect(dockDropAt(110, 400)).toEqual({ side: "right", index: 1 });
    expect(dockDropAt(170, 400)).toEqual({ side: "right", index: 2 });
    // Past every tab: to the end.
    expect(dockDropAt(500, 400)).toEqual({ side: "right", index: null });
  });

  it("keeps the target while the pointer is over the dragged tab's own slot", () => {
    // The slot is where the tab would land already. Re-deciding from it sends the
    // gap back and forth on every pointer move.
    dock("right", "x", [0, 1]);
    const slot = document.getElementById("tab1")!;
    slot.setAttribute("data-dock-placeholder", "");
    rect(slot, { left: 100, width: 80 });
    at("tab1");
    expect(dockDropAt(120, 5)).toBe("keep");
    expect(dockDropAt(170, 5)).toBe("keep");
  });

  it("reads a tab's slot from the layout, not from where it is drawn mid-slide", () => {
    // The neighbour has given way (its slot is 0…80) but its glide is not over:
    // it is still drawn at 100…180, under the pointer. It must count as moved.
    dock("right", "x", [0, 1]);
    const tab = document.getElementById("tab1")!;
    laidOut(tab, { left: 0, top: 0, width: 80, height: 30 });
    rect(tab, { left: 100, width: 80 });
    at("tab1");
    expect(dockDropAt(120, 5)).toEqual({ side: "right", index: null });
    expect(dockDropAt(60, 5)).toEqual({ side: "right", index: 2 });
  });

  it("skips a dock's tabs that are not laid out (the strip behind a collapsed rail)", () => {
    document.body.innerHTML = `
      <div data-dock-drop="right" id="dock">
        <div data-dock-axis="y"><button data-dock-tab="0" id="rail"></button></div>
        <div data-dock-axis="x"><button data-dock-tab="0" id="strip"></button></div>
      </div>`;
    laidOut(document.getElementById("rail")!, { left: 0, top: 100, width: 30, height: 60 });
    // `strip` has no offset parent — its container is `display: none`.
    rect(document.getElementById("strip")!, { left: 0, width: 500 });
    at("dock");
    // Along the rail's axis (y), not the hidden strip's (x).
    expect(dockDropAt(10, 110)).toEqual({ side: "right", index: 0 });
    expect(dockDropAt(10, 150)).toEqual({ side: "right", index: 1 });
  });
});

describe("dragging a panel tab", () => {
  it("is not a drag until the pointer has travelled", () => {
    dock("right", "x", [0]);
    const tab = document.getElementById("tab0")!;
    beginPanelDrag(press(tab), "docker");
    window.dispatchEvent(pointer("pointermove", 12, 11));
    expect(dockDrag.panel).toBeNull();
    window.dispatchEvent(pointer("pointerup", 12, 11));
    // A plain click must still reach the tab.
    expect(consumeDragClick()).toBe(false);
    expect(layout.docks.bottom.panels).toEqual(["docker", "k8s"]);
  });

  it("moves the panel to the dock it is dropped on, at the gap under the pointer", () => {
    dock("right", "x", [0, 1, 2]);
    const tab = document.getElementById("tab0")!;
    rect(document.getElementById("tab1")!, { left: 100, width: 80 });
    at("tab1");
    beginPanelDrag(press(tab), "docker");
    window.dispatchEvent(pointer("pointermove", 110, 40));
    expect(dockDrag.panel).toBe("docker");
    expect(tab.setPointerCapture).toHaveBeenCalledWith(7);
    expect(dockDrag.over).toEqual({ side: "right", index: 1 });
    // The copy hangs from the point the tab was grabbed at (10,10 inside it), so
    // it does not jump under the pointer when it is picked up.
    expect([dockDrag.x, dockDrag.y]).toEqual([100, 30]);

    window.dispatchEvent(pointer("pointerup", 110, 40));
    expect(layout.docks.right.panels).toEqual(["files", "docker", "git", "ai"]);
    expect(layout.docks.right.collapsed).toBe(false);
    expect(dockDrag.panel).toBeNull();
    expect(dockDrag.over).toBeNull();
    expect(tab.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("writes the target only when it is another one", () => {
    dock("right", "x", [0, 1, 2]);
    at("body");
    beginPanelDrag(press(document.getElementById("tab0")!), "docker");
    window.dispatchEvent(pointer("pointermove", 110, 240));
    const over = dockDrag.over;
    expect(over).toEqual({ side: "right", index: null });
    // Over a dock's body every move gives the same answer. Written again, it
    // would redraw the strips, and a redrawn strip starts its tabs' slides over.
    window.dispatchEvent(pointer("pointermove", 130, 260));
    expect(dockDrag.over).toBe(over);
    rect(document.getElementById("tab1")!, { left: 100, width: 80 });
    at("tab1");
    window.dispatchEvent(pointer("pointermove", 110, 40));
    expect(dockDrag.over).not.toBe(over);
    expect(dockDrag.over).toEqual({ side: "right", index: 1 });
  });

  it("swallows the click that ends a drag — once", async () => {
    dock("right", "x", [0]);
    at("body");
    beginPanelDrag(press(document.getElementById("tab0")!), "docker");
    window.dispatchEvent(pointer("pointermove", 80, 80));
    window.dispatchEvent(pointer("pointerup", 80, 80));
    expect(consumeDragClick()).toBe(true);
    expect(consumeDragClick()).toBe(false);
  });

  it("forgets an unused swallow by the next task", async () => {
    dock("right", "x", [0]);
    at("outside");
    beginPanelDrag(press(document.getElementById("tab0")!), "docker");
    window.dispatchEvent(pointer("pointermove", 80, 80));
    window.dispatchEvent(pointer("pointerup", 80, 80));
    await new Promise((r) => setTimeout(r, 0));
    // No click followed (released outside the window) — the next real click works.
    expect(consumeDragClick()).toBe(false);
  });

  it("does not offer a drop that would change nothing", () => {
    // "ai" is already the last tab of the right dock.
    dock("right", "x", [0, 1, 2]);
    at("body");
    beginPanelDrag(press(document.getElementById("tab2")!), "ai");
    window.dispatchEvent(pointer("pointermove", 80, 80));
    expect(dockDrag.panel).toBe("ai");
    expect(dockDrag.over).toBeNull();
    const before = layout.docks;
    window.dispatchEvent(pointer("pointerup", 80, 80));
    expect(layout.docks).toBe(before);
  });

  it("leaves the layout alone when dropped outside every dock", () => {
    dock("right", "x", [0]);
    at("outside");
    beginPanelDrag(press(document.getElementById("tab0")!), "docker");
    window.dispatchEvent(pointer("pointermove", 300, 300));
    window.dispatchEvent(pointer("pointerup", 300, 300));
    expect(layout.docks.bottom.panels).toEqual(["docker", "k8s"]);
  });

  it("is abandoned on pointercancel", () => {
    dock("right", "x", [0]);
    at("body");
    beginPanelDrag(press(document.getElementById("tab0")!), "docker");
    window.dispatchEvent(pointer("pointermove", 80, 80));
    window.dispatchEvent(pointer("pointercancel", 80, 80));
    expect(dockDrag.panel).toBeNull();
    window.dispatchEvent(pointer("pointerup", 80, 80));
    expect(layout.docks.bottom.panels).toEqual(["docker", "k8s"]);
  });

  it("starts only from the primary button", () => {
    dock("right", "x", [0]);
    const tab = document.getElementById("tab0")!;
    const e = new PointerEvent("pointerdown", { clientX: 1, clientY: 1, button: 2 });
    Object.defineProperty(e, "currentTarget", { value: tab });
    beginPanelDrag(e, "docker");
    window.dispatchEvent(pointer("pointermove", 90, 90));
    expect(dockDrag.panel).toBeNull();
  });

  it("survives a tab element that cannot capture the pointer", () => {
    dock("right", "x", [0]);
    at("body");
    const tab = document.getElementById("tab0")!;
    const e = press(tab);
    tab.setPointerCapture = () => {
      throw new Error("gone");
    };
    tab.releasePointerCapture = () => {
      throw new Error("gone");
    };
    beginPanelDrag(e, "docker");
    window.dispatchEvent(pointer("pointermove", 80, 80));
    expect(dockDrag.panel).toBe("docker");
    window.dispatchEvent(pointer("pointerup", 80, 80));
    expect(layout.docks.right.panels).toEqual(["files", "git", "ai", "docker"]);
  });
});

describe("the dragged tab's copy", () => {
  it("takes the size and lettering of the tab that was picked up", () => {
    dock("right", "y", [0]);
    const tab = document.getElementById("tab0")!;
    rect(tab, { left: 700, top: 120, width: 28, height: 64 });
    beginPanelDrag(press(tab, 710, 130), "files");
    expect([dockDrag.width, dockDrag.height]).toEqual([28, 64]);
    // From a collapsed dock's rail: the label is set vertically.
    expect(dockDrag.vertical).toBe(true);
    window.dispatchEvent(pointer("pointermove", 760, 180));
    expect([dockDrag.x, dockDrag.y]).toEqual([750, 170]);
  });

  it("keeps its target while it passes over its own slot", () => {
    dock("right", "x", [0, 1, 2]);
    const tab = document.getElementById("tab0")!;
    rect(document.getElementById("tab1")!, { left: 100, width: 80 });
    at("tab1");
    beginPanelDrag(press(tab), "docker");
    window.dispatchEvent(pointer("pointermove", 170, 40));
    expect(dockDrag.over).toEqual({ side: "right", index: 2 });
    // The strip now holds a slot for it; the pointer is over that slot.
    const slot = document.getElementById("tab2")!;
    slot.setAttribute("data-dock-placeholder", "");
    rect(slot, { left: 180, width: 80 });
    window.dispatchEvent(pointer("pointermove", 200, 40));
    expect(dockDrag.over).toEqual({ side: "right", index: 2 });
  });
});

describe("releasing the dragged tab", () => {
  /** A drag of Docker onto the open right dock, with the slot the strip holds for it. */
  function dragOverRight(slotBox = { left: 400, top: 60, width: 120, height: 30 }) {
    layout.docks.right.collapsed = false;
    dock("right", "x", [0, 1, 2]);
    rect(document.getElementById("tab1")!, { left: 100, width: 80 });
    at("tab1");
    beginPanelDrag(press(document.getElementById("tab0")!), "docker");
    window.dispatchEvent(pointer("pointermove", 110, 40));
    const slot = document.createElement("button");
    slot.setAttribute("data-dock-placeholder", "");
    document.body.appendChild(slot);
    laidOut(slot, slotBox);
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("moves the panel at once, then lets the copy glide into its slot", () => {
    dragOverRight();
    window.dispatchEvent(pointer("pointerup", 110, 40));
    // The layout does not wait for the animation.
    expect(layout.docks.right.panels).toEqual(["files", "docker", "git", "ai"]);
    expect(dockDrag.settling).toBe(true);
    expect(dockDrag.panel).toBe("docker");
    expect([dockDrag.x, dockDrag.y]).toEqual([400, 60]);
    // No target any more: the strips draw the layout as it now is.
    expect(dockDrag.over).toBeNull();
    vi.advanceTimersByTime(200);
    expect(dockDrag.panel).toBeNull();
    expect(dockDrag.settling).toBe(false);
  });

  it("does not follow the pointer while it settles", () => {
    dragOverRight();
    window.dispatchEvent(pointer("pointerup", 110, 40));
    window.dispatchEvent(pointer("pointermove", 900, 900));
    expect([dockDrag.x, dockDrag.y]).toEqual([400, 60]);
  });

  it("glides back to where it came from when dropped on nothing", () => {
    dragOverRight({ left: 36, top: 500, width: 70, height: 24 });
    at("outside");
    window.dispatchEvent(pointer("pointermove", 300, 300));
    expect(dockDrag.over).toBeNull();
    window.dispatchEvent(pointer("pointerup", 300, 300));
    expect(layout.docks.bottom.panels).toEqual(["docker", "k8s"]);
    expect(dockDrag.settling).toBe(true);
    expect([dockDrag.x, dockDrag.y]).toEqual([36, 500]);
  });

  it("skips the glide when the drop opens a collapsed dock — its slot is about to move", () => {
    dragOverRight();
    layout.docks.right.collapsed = true;
    window.dispatchEvent(pointer("pointerup", 110, 40));
    expect(layout.docks.right.collapsed).toBe(false);
    expect(dockDrag.panel).toBeNull();
    expect(dockDrag.settling).toBe(false);
  });

  it("skips the glide when there is no slot laid out to glide to", () => {
    layout.docks.right.collapsed = false;
    dock("right", "x", [0, 1, 2]);
    rect(document.getElementById("tab1")!, { left: 100, width: 80 });
    at("tab1");
    beginPanelDrag(press(document.getElementById("tab0")!), "docker");
    window.dispatchEvent(pointer("pointermove", 110, 40));
    window.dispatchEvent(pointer("pointerup", 110, 40));
    expect(layout.docks.right.panels).toEqual(["files", "docker", "git", "ai"]);
    expect(dockDrag.panel).toBeNull();
  });

  it("does not animate at all under reduced motion", () => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
    })) as typeof globalThis.matchMedia;
    try {
      dragOverRight();
      window.dispatchEvent(pointer("pointerup", 110, 40));
      expect(layout.docks.right.panels).toEqual(["files", "docker", "git", "ai"]);
      expect(dockDrag.panel).toBeNull();
      expect(dockDrag.settling).toBe(false);
    } finally {
      globalThis.matchMedia = original;
    }
  });

  it("a new drag ends a glide that is still running", () => {
    dragOverRight();
    window.dispatchEvent(pointer("pointerup", 110, 40));
    expect(dockDrag.settling).toBe(true);
    beginPanelDrag(press(document.getElementById("tab2")!), "ai");
    expect(dockDrag.panel).toBeNull();
    expect(dockDrag.settling).toBe(false);
    // …and the old timer does not clear the new drag later.
    window.dispatchEvent(pointer("pointermove", 300, 300));
    expect(dockDrag.panel).toBe("ai");
    vi.advanceTimersByTime(500);
    expect(dockDrag.panel).toBe("ai");
  });
});
