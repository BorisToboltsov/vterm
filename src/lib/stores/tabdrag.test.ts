import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panes } from "../splitlayout";
import {
  beginTabDrag,
  cancelTabDrag,
  consumeTabDragClick,
  onTabDraggedOutside,
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
  onTabDraggedOutside(null);
  vi.useRealTimers();
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

  it("writes the target only when it is another one — a move inside a slot is not", () => {
    beginTabDrag(press(byId("tabA")), a);
    at("stripR");
    move(690, 10); // past the middle of `c`
    const over = tabDrag.over;
    expect(over).toEqual({ kind: "strip", pane: right, index: 1 });
    // Every move works the target out afresh. The same one written again would
    // redraw the strips, and a redrawn strip starts its tabs' slides over.
    move(692, 10);
    move(699, 14);
    expect(tabDrag.over).toBe(over);
    move(610, 10); // back before the middle of `c`: another slot
    expect(tabDrag.over).not.toBe(over);
    expect(tabDrag.over).toEqual({ kind: "strip", pane: right, index: 0 });

    at("inR");
    move(900, 420);
    const zone = tabDrag.zone;
    expect(zone).toEqual({ x: 600, y: 230, w: 600, h: 200 });
    move(905, 425);
    expect(tabDrag.zone).toBe(zone);
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

const esc = () => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};

describe("Esc puts a dragged tab back", () => {
  it("nothing moves, and the key goes no further", () => {
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    at("stripB");
    beginTabDrag(press(byId("tabA")), a);
    move(300, 20);
    expect(tabDrag.tab).toBe(a);
    const before = shape();
    const e = esc();
    expect(e.defaultPrevented).toBe(true);
    expect(heard).not.toHaveBeenCalled();
    expect(tabDrag.tab).toBeNull();
    expect(tabDrag.over).toBeNull();
    // The button is still down: letting go of it now moves nothing, and is
    // not a click on the tab that was held.
    expect(consumeTabDragClick()).toBe(true);
    release();
    expect(shape()).toEqual(before);
    window.removeEventListener("keydown", heard);
  });

  it("a press that is not a drag yet leaves Esc alone", () => {
    beginTabDrag(press(byId("tabA")), a);
    expect(esc().defaultPrevented).toBe(false);
    release();
  });

  it("a window that was drawing the tab is told it left", async () => {
    const left = vi.fn();
    onTabDraggedOutside({
      release: vi.fn(),
      over: async () => ({ window: "win-2", floating: false }),
      left,
    });
    at("stripB");
    beginTabDrag(press(byId("tabA")), a);
    move(300, 20);
    await Promise.resolve();
    await Promise.resolve();
    esc();
    await Promise.resolve();
    await Promise.resolve();
    expect(left).toHaveBeenCalledTimes(1);
    onTabDraggedOutside(null);
  });
});

describe("a tab let go of outside the window", () => {
  // jsdom's window is 1024×768.
  const releaseAt = (x: number, y: number, screenX: number, screenY: number) =>
    window.dispatchEvent(
      new PointerEvent("pointerup", { clientX: x, clientY: y, screenX, screenY, pointerId: 7 }),
    );

  it("is handed to the page, with where on the screen it was dropped", () => {
    const moved = vi.fn();
    onTabDraggedOutside({ release: moved });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    at("bodyR");
    move(900, 230);
    expect(tabDrag.outside).toBe(false);
    expect(tabDrag.over).not.toBeNull();
    // Past the right edge: no pane to land in, only another window.
    move(1500, 230);
    expect(tabDrag.outside).toBe(true);
    expect(tabDrag.over).toBeNull();
    expect(tabDrag.zone).toBeNull();
    releaseAt(1500, 230, 2100, 400);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(moved).toHaveBeenCalledWith(a, { x: 2100, y: 400 }, true);
    // The layout here is not touched — the page moves the tab once it is taken.
    expect(shape()).toEqual([[a, b], [c]]);
    expect(tabDrag.tab).toBeNull();
    expect(tabDrag.outside).toBe(false);
    expect(consumeTabDragClick()).toBe(true);
  });

  it("coming back inside is an ordinary drop again", () => {
    const moved = vi.fn();
    onTabDraggedOutside({ release: moved });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    move(-20, 40);
    expect(tabDrag.outside).toBe(true);
    at("stripR");
    move(690, 10);
    expect(tabDrag.outside).toBe(false);
    releaseAt(690, 10, 0, 0);
    expect(moved).not.toHaveBeenCalled();
    expect(shape()).toEqual([[b], [c, a]]);
  });

  it("is decided by where the pointer was released, not by its last move", () => {
    const moved = vi.fn();
    onTabDraggedOutside({ release: moved });
    beginTabDrag(press(byId("tabA")), a);
    at("stripR");
    move(690, 10);
    expect(tabDrag.over).not.toBeNull();
    // The release itself is past the bottom edge.
    releaseAt(690, 800, 690, 1000);
    expect(moved).toHaveBeenCalledWith(a, { x: 690, y: 1000 }, true);
    expect(shape()).toEqual([[a, b], [c]]);
  });

  it("a press that never became a drag moves nothing", () => {
    const moved = vi.fn();
    onTabDraggedOutside({ release: moved });
    beginTabDrag(press(byId("tabA")), a);
    releaseAt(-50, -50, 0, 0);
    expect(moved).not.toHaveBeenCalled();
  });

  it("with nobody to hand it to, the drag just ends", () => {
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    // A real page has no element under a point outside its window.
    at(null);
    move(1500, 230);
    expect(tabDrag.outside).toBe(false);
    releaseAt(1500, 230, 0, 0);
    expect(shape()).toEqual([[a, b], [c]]);
  });
});

describe("a dragged tab the backend is told of", () => {
  /** Let what was said (a resolved promise and what hangs on it) land. */
  const said = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const sight = (window: string | null, floating = false) => ({ window, floating });

  /** An `over` answered by hand: `answer[i]` settles the i-th call. */
  function manualOver() {
    const answer: ((s: { window: string | null; floating: boolean } | null) => void)[] = [];
    const over = vi.fn(
      (_tab: string) =>
        new Promise<{ window: string | null; floating: boolean } | null>((resolve) =>
          answer.push(resolve),
        ),
    );
    return { over, answer };
  }

  const releaseAt = (x: number, y: number) =>
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        clientX: x,
        clientY: y,
        screenX: x + 600,
        screenY: y + 170,
        pointerId: 7,
      }),
    );

  it("is told of on every move once it is a drag — inside the window too", async () => {
    const over = vi.fn().mockResolvedValue(sight(null));
    onTabDraggedOutside({ release: vi.fn(), over });
    beginTabDrag(press(byId("tabA")), a);
    // A press is not a drag yet: nothing to tell.
    expect(over).not.toHaveBeenCalled();
    at("bodyR");
    move(900, 230);
    expect(over).toHaveBeenCalledTimes(1);
    expect(over).toHaveBeenCalledWith(a);
    await said();
    // Over no other window: the panes of this one are still the targets.
    expect(tabDrag.window).toBeNull();
    move(910, 230);
    expect(tabDrag.over).not.toBeNull();
  });

  it("over another window — even inside this one's bounds — no pane here is a target", async () => {
    const over = vi.fn().mockResolvedValue(sight("win-2"));
    onTabDraggedOutside({ release: vi.fn(), over });
    beginTabDrag(press(byId("tabA")), a);
    at("bodyR");
    move(900, 230);
    // Until the backend answers, the page can only go by its own bounds.
    expect(tabDrag.over).not.toBeNull();
    await said();
    expect(tabDrag.window).toBe("win-2");
    expect(tabDrag.over).toBeNull();
    expect(tabDrag.zone).toBeNull();
    // And it stays so while the pointer moves on under that window.
    move(905, 230);
    expect(tabDrag.over).toBeNull();
  });

  it("over none of the app's windows a floating label draws it", async () => {
    const over = vi.fn().mockResolvedValue(sight(null, true));
    onTabDraggedOutside({ release: vi.fn(), over });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    move(1500, 230);
    await said();
    expect(tabDrag.outside).toBe(true);
    expect(tabDrag.floating).toBe(true);
    expect(tabDrag.window).toBeNull();
  });

  it("is told one move at a time — and the place the pointer stopped at is always told", async () => {
    const { over, answer } = manualOver();
    onTabDraggedOutside({ release: vi.fn(), over });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    move(1500, 230);
    move(1510, 230);
    // Three moves, one call out.
    expect(over).toHaveBeenCalledTimes(1);
    answer[0](sight(null));
    await said();
    // The moves made meanwhile are told once, now.
    expect(over).toHaveBeenCalledTimes(2);
    answer[1](sight("main"));
    await said();
    expect(tabDrag.window).toBe("main");
    // Nothing moved since: nothing more to tell.
    expect(over).toHaveBeenCalledTimes(2);
  });

  it("dropped on a pane of this window, the drag is said to be over", async () => {
    const left = vi.fn();
    onTabDraggedOutside({ release: vi.fn(), over: vi.fn().mockResolvedValue(sight(null)), left });
    beginTabDrag(press(byId("tabA")), a);
    at("stripR");
    move(690, 10);
    await said();
    release();
    expect(left).toHaveBeenCalledTimes(1);
    expect(shape()).toEqual([[b], [c, a]]);
  });

  it("a drag cancelled is said to be over — after what was still being told", async () => {
    const { over, answer } = manualOver();
    const left = vi.fn();
    onTabDraggedOutside({ release: vi.fn(), over, left });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    move(1500, 230);
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 7 }));
    expect(left).not.toHaveBeenCalled();
    answer[0](sight("win-2"));
    await said();
    expect(left).toHaveBeenCalledTimes(1);
    // The late answer is about a drag that is over.
    expect(tabDrag.window).toBeNull();
    expect(tabDrag.floating).toBe(false);
  });

  it("let go of outside it is handed to the page — not said to be over", async () => {
    const left = vi.fn();
    const moved = vi.fn();
    onTabDraggedOutside({ release: moved, over: vi.fn().mockResolvedValue(sight("win-2")), left });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    move(1500, 230);
    await said();
    releaseAt(1500, 230);
    expect(moved).toHaveBeenCalledWith(a, { x: 2100, y: 400 }, true);
    expect(left).not.toHaveBeenCalled();
  });

  it("let go of inside this window's bounds but over another window, it went to that window", async () => {
    const moved = vi.fn();
    onTabDraggedOutside({ release: moved, over: vi.fn().mockResolvedValue(sight("win-2")) });
    beginTabDrag(press(byId("tabA")), a);
    at("bodyR");
    move(900, 230);
    await said();
    releaseAt(900, 230);
    // Handed to the page as a drop away from here — `outside` says it was within the bounds.
    expect(moved).toHaveBeenCalledWith(a, { x: 1500, y: 400 }, false);
    // No pane of this window took it.
    expect(shape()).toEqual([[a, b], [c]]);
  });

  it("the release waits for the move that was still being told", async () => {
    const { over, answer } = manualOver();
    const moved = vi.fn();
    onTabDraggedOutside({ release: moved, over });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    move(1500, 230);
    releaseAt(1500, 230);
    // The backend must hear the drop after the last move, not before it.
    expect(moved).not.toHaveBeenCalled();
    answer[0](sight("win-2"));
    await said();
    expect(moved).toHaveBeenCalledTimes(1);
    expect(over).toHaveBeenCalledTimes(1);
  });

  it("is forgotten with the drag — an answer for the last one is not shown on the next", async () => {
    const { over, answer } = manualOver();
    onTabDraggedOutside({ release: vi.fn(), over });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    release();
    expect(tabDrag.window).toBeNull();
    // A new drag is told at once, the old call still out.
    beginTabDrag(press(byId("tabB")), b);
    move(140, 40);
    expect(over).toHaveBeenCalledTimes(2);
    answer[0](sight("win-2", true));
    await said();
    expect(tabDrag.window).toBeNull();
    expect(tabDrag.floating).toBe(false);
    answer[1](sight("main"));
    await said();
    expect(tabDrag.window).toBe("main");
  });

  it("a call that fails reads as nowhere, not as an error", async () => {
    const over = vi.fn().mockRejectedValue(new Error("ipc"));
    onTabDraggedOutside({ release: vi.fn(), over });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    move(1500, 230);
    await said();
    expect(tabDrag.window).toBeNull();
    expect(tabDrag.floating).toBe(false);
    // Both moves were told (the second once the first had failed)…
    expect(over).toHaveBeenCalledTimes(2);
    // …and the next one is told all the same.
    move(1510, 230);
    expect(over).toHaveBeenCalledTimes(3);
  });

  it("with no `over` to call, a dragged tab is told to nobody", () => {
    const left = vi.fn();
    onTabDraggedOutside({ release: vi.fn(), left });
    beginTabDrag(press(byId("tabA")), a);
    move(40, 40);
    move(1500, 230);
    expect(tabDrag.outside).toBe(true);
    release();
    // Nothing was said, so there is nothing to take back.
    expect(left).not.toHaveBeenCalled();
  });
});

describe("a pane with no tabs", () => {
  it("is not offered an edge — the tab becomes its first, it is not split", () => {
    resetTabs();
    const only = tabsState.center.focus;
    document.body.innerHTML = `<div data-pane-body="${only}" id="body"></div>`;
    rect(byId("body"), { left: 0, top: 30, width: 1200, height: 600 });
    at("body");
    // Far left: an edge anywhere else.
    expect(tabDropAt(10, 300, "@incoming")?.drop).toEqual({
      kind: "pane",
      pane: only,
      zone: "center",
    });
  });
});
