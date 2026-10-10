import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorLang } from "../editorlang";
import { TERMINAL_VIEW } from "../sessionviews";
import { paneOf, panes } from "../splitlayout";
import {
  beginViewDrag,
  cancelViewDrag,
  consumeViewDragClick,
  viewDrag,
  viewDropAt,
} from "./viewdrag.svelte";
import {
  addEditor,
  getWorkspace,
  peekWorkspace,
  splitSessionView,
  workspacesState,
} from "./workspaces.svelte";

const LANG: EditorLang = { kind: "yaml", label: "YAML" };
const T = TERMINAL_VIEW;
const S = "s1";

// jsdom has no layout: `elementFromPoint` is supplied per test, and an element's
// rectangle is whatever the test says it is.
function rect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () => r as DOMRect;
}

/** Give a view a layout position (jsdom lays nothing out); the parent is at the origin. */
function laidOut(el: HTMLElement, left: number, width: number) {
  const parent = document.body;
  parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
  Object.defineProperties(el, {
    offsetParent: { value: parent, configurable: true },
    offsetLeft: { value: left, configurable: true },
    offsetTop: { value: 0, configurable: true },
    offsetWidth: { value: width, configurable: true },
    offsetHeight: { value: 28, configurable: true },
  });
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const at = (id: string | null) =>
  (document.elementFromPoint = () => (id === null ? null : document.getElementById(id)));

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, button: 0, bubbles: true });

/** A press on a view's element, the way a strip's `onpointerdown` hands it over. */
function press(el: HTMLElement, x = 10, y = 10, button = 0) {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  const e = new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId: 7, button });
  Object.defineProperty(e, "currentTarget", { value: el });
  return e;
}

const move = (x: number, y: number) => window.dispatchEvent(pointer("pointermove", x, y));
const release = () => window.dispatchEvent(pointer("pointerup", 0, 0));

/** Zones in reading order, `*` on the view each shows. */
const shape = (sid = S): string[][] =>
  panes(getWorkspace(sid).layout).map((zone) =>
    zone.tabs.map((view) => (zone.active === view ? `${view}*` : view)),
  );

let a = "";
let b = "";
let left = "";
let right = "";

/**
 * A connection `s1` with two zones — `[terminal a] | [b]` — drawn the way the
 * page marks them: its area (`data-views-of`), a strip per zone (100px views
 * from the zone's left edge) and what each zone shows below it. Beside it, the
 * area of another connection and something that is no connection at all.
 */
function page() {
  document.body.innerHTML = `
    <div data-views-of="${S}" id="area">
      <div data-viewstrip="${left}" id="stripL">
        <div data-view="${T}" id="viewT"></div><div data-view="${a}" id="viewA"></div>
      </div>
      <div data-viewstrip="${right}" id="stripR"><div data-view="${b}" id="viewB"></div></div>
      <div data-zone-body="${left}" id="bodyL"><i id="inL"></i></div>
      <div data-zone-body="${right}" id="bodyR"><i id="inR"></i></div>
    </div>
    <div data-views-of="other" id="otherArea">
      <div data-viewstrip="${left}" id="otherStrip"></div>
      <div data-zone-body="${left}" id="otherBody"></div>
    </div>
    <div id="dock"></div>`;
  laidOut(byId("viewT"), 0, 100);
  laidOut(byId("viewA"), 100, 100);
  laidOut(byId("viewB"), 600, 100);
  rect(byId("area"), { left: 0, top: 0, width: 1200, height: 428 });
  rect(byId("stripL"), { left: 0, top: 0, width: 600, height: 28 });
  rect(byId("stripR"), { left: 600, top: 0, width: 600, height: 28 });
  rect(byId("bodyL"), { left: 0, top: 28, width: 600, height: 400 });
  rect(byId("bodyR"), { left: 600, top: 28, width: 600, height: 400 });
}

beforeEach(() => {
  cancelViewDrag();
  workspacesState.map = {};
  a = addEditor(S, "/a", "a", LANG);
  b = addEditor(S, "/b", "b", LANG);
  splitSessionView(S, b, "right");
  left = paneOf(getWorkspace(S).layout, T)!.id;
  right = paneOf(getWorkspace(S).layout, b)!.id;
  page();
});

afterEach(() => {
  cancelViewDrag();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("viewDropAt", () => {
  it("over a strip: the slot among that strip's other views", () => {
    at("stripL");
    // The terminal dragged past the middle of `a` (150) → after it.
    expect(viewDropAt(160, 10, S, T)).toEqual({
      drop: { kind: "strip", pane: left, index: 1 },
      zone: null,
    });
    expect(viewDropAt(140, 10, S, T)?.drop).toEqual({ kind: "strip", pane: left, index: 0 });
    // Another zone's view over this strip counts both of its views.
    expect(viewDropAt(160, 10, S, b)?.drop).toEqual({ kind: "strip", pane: left, index: 2 });
    expect(viewDropAt(20, 10, S, b)?.drop).toEqual({ kind: "strip", pane: left, index: 0 });
  });

  it("over a view of a strip is over that strip", () => {
    at("viewB");
    expect(viewDropAt(700, 10, S, a)?.drop).toEqual({ kind: "strip", pane: right, index: 1 });
  });

  it("over a zone's body: its middle joins the zone, an edge opens a zone there", () => {
    at("inR");
    expect(viewDropAt(900, 228, S, a)).toEqual({
      drop: { kind: "pane", pane: right, zone: "center" },
      zone: { x: 600, y: 28, w: 600, h: 400 },
    });
    // Near the bottom edge: the lower half is what the view would take.
    expect(viewDropAt(900, 420, S, a)).toEqual({
      drop: { kind: "pane", pane: right, zone: "bottom" },
      zone: { x: 600, y: 228, w: 600, h: 200 },
    });
    expect(viewDropAt(610, 228, S, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "left" });
  });

  it("an edge is offered only while the zone is big enough for two", () => {
    at("inR");
    // 400 px wide: no room for two zones side by side — but still for one above the other.
    rect(byId("bodyR"), { left: 600, top: 28, width: 400, height: 400 });
    expect(viewDropAt(990, 228, S, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "center" });
    expect(viewDropAt(800, 420, S, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "bottom" });
    // The strip counts towards the zone's height: 28 + 253 is just enough.
    rect(byId("bodyR"), { left: 600, top: 28, width: 600, height: 253 });
    expect(viewDropAt(900, 275, S, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "bottom" });
    rect(byId("bodyR"), { left: 600, top: 28, width: 600, height: 252 });
    expect(viewDropAt(900, 275, S, a)?.drop).toEqual({ kind: "pane", pane: right, zone: "center" });
  });

  it("outside its connection there is no target — another connection's zones included", () => {
    at("dock");
    expect(viewDropAt(5, 5, S, a)).toBeNull();
    at("otherStrip");
    expect(viewDropAt(5, 5, S, a)).toBeNull();
    at("otherBody");
    expect(viewDropAt(5, 5, S, a)).toBeNull();
    at(null);
    expect(viewDropAt(5, 5, S, a)).toBeNull();
    // The connection's own area, but neither a strip nor what a zone shows.
    at("area");
    expect(viewDropAt(5, 5, S, a)).toBeNull();
  });
});

describe("dragging a view", () => {
  it("a press is not a drag: nothing is in the air until the pointer moves", () => {
    beginViewDrag(press(byId("viewA")), S, a);
    expect(viewDrag.view).toBeNull();
    move(12, 11);
    expect(viewDrag.view).toBeNull();
    release();
    expect(consumeViewDragClick()).toBe(false);
  });

  it("only the main button starts one", () => {
    beginViewDrag(press(byId("viewA"), 10, 10, 2), S, a);
    move(100, 100);
    expect(viewDrag.view).toBeNull();
  });

  it("dragged down onto the body's lower edge, the file takes the lower half — on release", () => {
    const before = peekWorkspace(S);
    at("inL");
    beginViewDrag(press(byId("viewA"), 150, 10), S, a);
    move(150, 420);
    expect(viewDrag).toMatchObject({
      session: S,
      view: a,
      over: { kind: "pane", pane: left, zone: "bottom" },
      zone: { x: 0, y: 228, w: 600, h: 200 },
      area: { x: 0, y: 0, w: 1200, h: 428 },
    });
    // Shown, not done: the layout is what it was.
    expect(peekWorkspace(S)).toBe(before);
    release();
    expect(shape()).toEqual([[`${T}*`], [`${a}*`], [`${b}*`]]);
    expect(viewDrag.view).toBeNull();
    expect(viewDrag.zone).toBeNull();
  });

  it("the terminal is dragged like any view", () => {
    at("inR");
    beginViewDrag(press(byId("viewT"), 50, 10), S, T);
    move(900, 228);
    expect(viewDrag.over).toEqual({ kind: "pane", pane: right, zone: "center" });
    release();
    expect(shape()).toEqual([[`${a}*`], [b, `${T}*`]]);
  });

  it("along its strip it changes places; into another strip it moves there", () => {
    at("stripL");
    beginViewDrag(press(byId("viewA"), 150, 10), S, a);
    move(20, 10);
    expect(viewDrag.over).toEqual({ kind: "strip", pane: left, index: 0 });
    release();
    expect(shape()[0].map((v) => v.replace(/\*/g, ""))).toEqual([a, T]);

    at("stripR");
    beginViewDrag(press(byId("viewA"), 50, 10), S, a);
    move(620, 10);
    release();
    expect(panes(getWorkspace(S).layout).map((z) => z.tabs)).toEqual([[T], [a, b]]);
  });

  it("writes the target only when it is another one — a move inside a slot is not", () => {
    at("stripL");
    beginViewDrag(press(byId("viewA"), 150, 10), S, a);
    move(20, 10);
    const over = viewDrag.over;
    const area = viewDrag.area;
    expect(over).toEqual({ kind: "strip", pane: left, index: 0 });
    // The same target written again would redraw the strip, and a redrawn
    // strip starts its views' slides over.
    move(24, 12);
    expect(viewDrag.over).toBe(over);
    expect(viewDrag.area).toBe(area);

    at("inL");
    move(300, 420);
    const zone = viewDrag.zone;
    expect(zone).not.toBeNull();
    expect(viewDrag.over).not.toBe(over);
    move(310, 424);
    expect(viewDrag.zone).toBe(zone);
  });

  it("a drop that would change nothing is not offered", () => {
    // `b` is its zone's only view: its own body, anywhere, is where it already is.
    at("inR");
    beginViewDrag(press(byId("viewB"), 650, 10), S, b);
    move(900, 228);
    expect(viewDrag.view).toBe(b);
    expect(viewDrag.over).toBeNull();
    expect(viewDrag.zone).toBeNull();
    move(900, 420);
    expect(viewDrag.over).toBeNull();
    const before = peekWorkspace(S);
    release();
    expect(peekWorkspace(S)).toBe(before);
  });

  it("taken out of its connection it has nowhere to land, and let go of there it stays", () => {
    at("inL");
    beginViewDrag(press(byId("viewA"), 150, 10), S, a);
    move(150, 420);
    expect(viewDrag.over).not.toBeNull();
    // Over a dock, over another connection, over nothing at all.
    for (const id of ["dock", "otherBody", null]) {
      at(id);
      move(1500, 600);
      expect(viewDrag.over).toBeNull();
      expect(viewDrag.zone).toBeNull();
    }
    // The area it cannot leave is still known — the label stops at its edge.
    expect(viewDrag.area).toEqual({ x: 0, y: 0, w: 1200, h: 428 });
    const before = peekWorkspace(S);
    release();
    expect(peekWorkspace(S)).toBe(before);
    expect(shape()).toEqual([[T, `${a}*`], [`${b}*`]]);
  });

  it("the click that ends a drag does not show the view it started from", () => {
    vi.useFakeTimers();
    at("inR");
    beginViewDrag(press(byId("viewA"), 150, 10), S, a);
    move(900, 228);
    release();
    expect(consumeViewDragClick()).toBe(true);
    // Once: the next click is an ordinary one.
    expect(consumeViewDragClick()).toBe(false);
    // And it does not linger for a click that never came.
    beginViewDrag(press(byId("viewT"), 50, 10), S, T);
    move(900, 228);
    release();
    vi.runAllTimers();
    expect(consumeViewDragClick()).toBe(false);
  });

  it("the pointer is captured once it is a drag, and let go of at its end", () => {
    const el = byId("viewA");
    at("inR");
    beginViewDrag(press(el, 150, 10), S, a);
    expect(el.setPointerCapture).not.toHaveBeenCalled();
    move(900, 228);
    expect(el.setPointerCapture).toHaveBeenCalledWith(7);
    release();
    expect(el.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("a cancelled drag changes nothing", () => {
    at("inR");
    const before = peekWorkspace(S);
    beginViewDrag(press(byId("viewA"), 150, 10), S, a);
    move(900, 228);
    window.dispatchEvent(pointer("pointercancel", 0, 0));
    expect(viewDrag.view).toBeNull();
    expect(viewDrag.area).toBeNull();
    expect(peekWorkspace(S)).toBe(before);
    // Nor does one aborted from outside (a file that closes mid-drag).
    beginViewDrag(press(byId("viewA"), 150, 10), S, a);
    move(900, 228);
    cancelViewDrag();
    release();
    expect(peekWorkspace(S)).toBe(before);
  });

  it("the page is unselectable while a view is dragged", () => {
    beginViewDrag(press(byId("viewA"), 150, 10), S, a);
    expect(document.documentElement.classList.contains("dragging")).toBe(true);
    release();
    expect(document.documentElement.classList.contains("dragging")).toBe(false);
  });
});

const esc = () => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};

describe("Esc puts a dragged view back", () => {
  it("the layout is what it was, and the key goes no further", () => {
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    const before = shape();
    const el = document.createElement("div");
    beginViewDrag(press(el), S, T);
    move(200, 200);
    expect(viewDrag.view).toBe(T);
    const e = esc();
    expect(e.defaultPrevented).toBe(true);
    expect(heard).not.toHaveBeenCalled();
    expect(viewDrag.view).toBeNull();
    expect(consumeViewDragClick()).toBe(true);
    release();
    expect(shape()).toEqual(before);
    window.removeEventListener("keydown", heard);
  });

  it("with nothing in the air Esc is left alone", () => {
    expect(esc().defaultPrevented).toBe(false);
    beginViewDrag(press(document.createElement("div")), S, T);
    expect(esc().defaultPrevented).toBe(false);
    cancelViewDrag();
  });
});
