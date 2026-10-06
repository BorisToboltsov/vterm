import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panes } from "../splitlayout";
import {
  beginTabDrag,
  cancelTabDrag,
  consumeTabDragClick,
  tabDrag,
  tabDropAt,
} from "./tabdrag.svelte";
import { openLocalTab, resetTabs, splitTabOff, tabsState } from "./tabs.svelte";

// jsdom has no layout: `elementFromPoint` is supplied per test, and an element's
// rectangle is whatever the test says it is.
function rect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () => r as DOMRect;
}

/**
 * Give a tab a layout position distinct from where it is drawn — what it has
 * while it slides to a new slot. jsdom lays nothing out, so `offsetParent` and
 * the offsets are supplied; the parent sits at the viewport origin.
 */
function laidOut(el: HTMLElement, left: number, width: number) {
  const parent = document.body;
  parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
  Object.defineProperties(el, {
    offsetParent: { value: parent, configurable: true },
    offsetLeft: { value: left, configurable: true },
    offsetTop: { value: 0, configurable: true },
    offsetWidth: { value: width, configurable: true },
    offsetHeight: { value: 30, configurable: true },
  });
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const at = (id: string | null) =>
  (document.elementFromPoint = () => (id === null ? null : document.getElementById(id)));

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, button: 0, bubbles: true });

/** A press on a tab element, the way a strip's `onpointerdown` hands it over. */
function press(el: HTMLElement, x = 10, y = 10, button = 0) {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  const e = new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId: 7, button });
  Object.defineProperty(e, "currentTarget", { value: el });
  return e;
}

const move = (x: number, y: number) => window.dispatchEvent(pointer("pointermove", x, y));
const release = () => window.dispatchEvent(pointer("pointerup", 0, 0));

/** Tabs per pane, in reading order. */
const shape = () => panes(tabsState.center).map((p) => p.tabs);

let a = "";
let b = "";
let c = "";
let left = "";
let right = "";

/**
 * Two panes — `[a b] | [c]` — drawn the way the page marks them: a strip per
 * pane (100px tabs from the pane's left edge), the terminal bodies below, and
 * the whole pane as `data-pane`.
 */
function page() {
  document.body.innerHTML = `
    <div data-pane="${left}" id="paneL">
      <div data-tabstrip="${left}" id="stripL">
        <div data-tab="${a}" id="tabA"></div><div data-tab="${b}" id="tabB"></div>
      </div>
    </div>
    <div data-pane="${right}" id="paneR">
      <div data-tabstrip="${right}" id="stripR"><div data-tab="${c}" id="tabC"></div></div>
    </div>
    <div data-pane-body="${left}" id="bodyL"><i id="inL"></i></div>
    <div data-pane-body="${right}" id="bodyR"><i id="inR"></i></div>
    <div id="outside"></div>`;
  laidOut(byId("tabA"), 0, 100);
  laidOut(byId("tabB"), 100, 100);
  laidOut(byId("tabC"), 600, 100);
  rect(byId("paneL"), { left: 0, top: 0, width: 600, height: 430 });
  rect(byId("paneR"), { left: 600, top: 0, width: 600, height: 430 });
  rect(byId("bodyL"), { left: 0, top: 30, width: 600, height: 400 });
  rect(byId("bodyR"), { left: 600, top: 30, width: 600, height: 400 });
}

beforeEach(() => {
  cancelTabDrag();
  resetTabs();
  a = openLocalTab();
  b = openLocalTab();
  c = openLocalTab();
  left = tabsState.center.focus;
  splitTabOff(c, left, "right");
  right = tabsState.center.focus;
  page();
});

afterEach(() => {
  cancelTabDrag();
  document.body.innerHTML = "";
});

describe("tabDropAt", () => {
  it("over a strip: the slot among that strip's other tabs", () => {
    at("stripL");
    // `a` dragged past the middle of `b` (150) → after it.
    expect(tabDropAt(160, 10, a)).toEqual({
      drop: { kind: "strip", pane: left, index: 1 },
      zone: null,
    });
    expect(tabDropAt(140, 10, a)?.drop).toEqual({ kind: "strip", pane: left, index: 0 });
    // Another pane's tab over this strip counts both of its tabs.
    expect(tabDropAt(160, 10, c)?.drop).toEqual({ kind: "strip", pane: left, index: 2 });
    expect(tabDropAt(60, 10, c)?.drop).toEqual({ kind: "strip", pane: left, index: 1 });
  });

  it("decides the slot from where tabs sit, not where a slide draws them", () => {
    // `b` has given way and is drawn 100px to the left, mid-slide, while its
    // layout slot is still 100…200. Hit-testing the drawn box would put the
    // pointer past `b` and swap it straight back.
    rect(byId("tabB"), { left: 0, top: 0, width: 100, height: 30 });
    at("stripL");
    expect(tabDropAt(120, 10, a)?.drop).toEqual({ kind: "strip", pane: left, index: 0 });
  });

  it("the single strip of the broadcast view answers with a flat position", () => {
    byId("stripL").dataset.tabstrip = "*";
    at("stripL");
    expect(tabDropAt(160, 10, a)?.drop).toEqual({ kind: "flat", index: 1 });
  });

  it("over a pane's body: its middle, or the edge the pointer is near", () => {
    at("inR");
    expect(tabDropAt(900, 230, a)).toEqual({
      drop: { kind: "pane", pane: right, zone: "center" },
      zone: { x: 600, y: 30, w: 600, h: 400 },
    });
    expect(tabDropAt(1190, 230, a)).toEqual({
      drop: { kind: "pane", pane: right, zone: "right" },
      zone: { x: 900, y: 30, w: 300, h: 400 },
    });
    expect(tabDropAt(900, 420, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "bottom" });
  });

  it("offers an edge only while the pane has room to be split there", () => {
    rect(byId("paneR"), { left: 600, top: 0, width: 300, height: 200 });
    rect(byId("bodyR"), { left: 600, top: 30, width: 300, height: 170 });
    at("inR");
    // Too narrow for two panes side by side, too short for two stacked.
    expect(tabDropAt(890, 110, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "center" });
    expect(tabDropAt(750, 195, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "center" });
  });

  it("measures the body itself where there is no pane element (the centre unsplit)", () => {
    byId("paneR").remove();
    at("inR");
    expect(tabDropAt(1190, 230, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "right" });
  });

  it("is null over anything that is not a strip or a pane", () => {
    at("outside");
    expect(tabDropAt(5, 5, a)).toBeNull();
    at(null);
    expect(tabDropAt(5, 5, a)).toBeNull();
    // A body that names no pane (broadcast tiles carry no pane id).
    delete byId("bodyR").dataset.paneBody;
    at("inR");
    expect(tabDropAt(900, 230, a)).toBeNull();
  });
});

describe("dragging a tab", () => {
  it("a press alone is not a drag, and its click still activates the tab", () => {
    beginTabDrag(press(byId("tabA")), a);
    move(12, 11);
    expect(tabDrag.tab).toBeNull();
    release();
    expect(consumeTabDragClick()).toBe(false);
    expect(shape()).toEqual([[a, b], [c]]);
  });

  it("ignores every button but the primary one", () => {
    beginTabDrag(press(byId("tabA"), 10, 10, 2), a);
    move(200, 200);
    expect(tabDrag.tab).toBeNull();
  });

  it("starts once the pointer has moved, and follows it", () => {
    at("outside");
    const tab = byId("tabA");
    beginTabDrag(press(tab), a);
    move(40, 40);
    expect(tabDrag.tab).toBe(a);
    expect(tab.setPointerCapture).toHaveBeenCalledWith(7);
    expect([tabDrag.x, tabDrag.y]).toEqual([40, 40]);
    expect(tabDrag.over).toBeNull();
  });

  it("changes nothing until the release — then moves the tab once", () => {
    beginTabDrag(press(byId("tabA")), a);
    at("stripR");
    move(690, 10); // past the middle of `c`
    flushSync();
    expect(tabDrag.over).toEqual({ kind: "strip", pane: right, index: 1 });
    expect(shape()).toEqual([[a, b], [c]]);
    release();
    expect(shape()).toEqual([[b], [c, a]]);
    expect(tabsState.activeId).toBe(a);
    expect(tabDrag.tab).toBeNull();
    expect(tabDrag.over).toBeNull();
  });

  it("tints the half of a pane the tab would take, and splits there on release", () => {
    beginTabDrag(press(byId("tabA")), a);
    at("inR");
    move(900, 420);
    expect(tabDrag.zone).toEqual({ x: 600, y: 230, w: 600, h: 200 });
    expect(shape()).toEqual([[a, b], [c]]);
    release();
    expect(shape()).toEqual([[b], [c], [a]]);
    expect(tabDrag.zone).toBeNull();
  });

  it("does not offer a target that would change nothing", () => {
    beginTabDrag(press(byId("tabC")), c);
    // The body of its own pane; an edge of a pane it is alone in.
    at("inR");
    move(900, 230);
    expect(tabDrag.over).toBeNull();
    expect(tabDrag.zone).toBeNull();
    move(1190, 230);
    expect(tabDrag.over).toBeNull();
    // Its own slot in its own strip.
    at("stripR");
    move(610, 10);
    expect(tabDrag.over).toBeNull();
    release();
    expect(shape()).toEqual([[a, b], [c]]);
  });

  it("released over nothing, the tab stays where it was", () => {
    beginTabDrag(press(byId("tabA")), a);
    at("outside");
    move(400, 300);
    release();
    expect(shape()).toEqual([[a, b], [c]]);
  });

  it("swallows the click that ends a drag — once", () => {
    vi.useFakeTimers();
    beginTabDrag(press(byId("tabA")), a);
    at("outside");
    move(400, 300);
    release();
    expect(consumeTabDragClick()).toBe(true);
    expect(consumeTabDragClick()).toBe(false);
    // And not a later, unrelated click either.
    beginTabDrag(press(byId("tabA")), a);
    move(400, 300);
    release();
    vi.runAllTimers();
    expect(consumeTabDragClick()).toBe(false);
    vi.useRealTimers();
  });

  it("a cancelled pointer drops the drag without moving anything", () => {
    const tab = byId("tabA");
    beginTabDrag(press(tab), a);
    at("stripR");
    move(690, 10);
    window.dispatchEvent(pointer("pointercancel", 0, 0));
    expect(tabDrag.tab).toBeNull();
    expect(tab.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(shape()).toEqual([[a, b], [c]]);
    // The window is no longer listened to.
    move(690, 10);
    expect(tabDrag.tab).toBeNull();
  });

  it("survives a tab element that cannot take or give back the pointer", () => {
    const tab = byId("tabA");
    const e = press(tab);
    tab.setPointerCapture = () => {
      throw new Error("gone");
    };
    tab.releasePointerCapture = () => {
      throw new Error("gone");
    };
    beginTabDrag(e, a);
    at("stripR");
    move(690, 10);
    expect(tabDrag.tab).toBe(a);
    release();
    expect(shape()).toEqual([[b], [c, a]]);
  });

  it("a new press replaces a drag that never finished", () => {
    beginTabDrag(press(byId("tabA")), a);
    at("stripR");
    move(690, 10);
    beginTabDrag(press(byId("tabB")), b);
    expect(tabDrag.tab).toBeNull();
    move(690, 10);
    expect(tabDrag.tab).toBe(b);
  });
});
