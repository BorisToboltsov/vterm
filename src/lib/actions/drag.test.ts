import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRAGGING_CLASS,
  dropTargetAt,
  glide,
  holdSelection,
  layoutBox,
  passedThreshold,
  resizableHandle,
  slotIndex,
} from "./drag";

describe("holdSelection", () => {
  /** Whether a selection starting now would be refused. */
  const refused = () => {
    const e = new Event("selectstart", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const held = () => document.documentElement.classList.contains(DRAGGING_CLASS);
  const letGo = (type = "pointerup") => window.dispatchEvent(new Event(type));

  afterEach(() => letGo());

  it("until it is called, selecting is the browser's business", () => {
    expect(refused()).toBe(false);
    expect(held()).toBe(false);
  });

  it("from the press on, no selection starts and the page says so", () => {
    holdSelection();
    expect(refused()).toBe(true);
    expect(held()).toBe(true);
    // A drag is many moves: it is refused every time, not once.
    expect(refused()).toBe(true);
  });

  it("ends with the release", () => {
    holdSelection();
    letGo("pointerup");
    expect(refused()).toBe(false);
    expect(held()).toBe(false);
  });

  it("ends with a cancelled pointer and with the window losing focus", () => {
    for (const end of ["pointercancel", "blur"]) {
      holdSelection();
      expect(refused()).toBe(true);
      letGo(end);
      expect(refused(), end).toBe(false);
      expect(held(), end).toBe(false);
    }
  });

  it("held twice is held once — one release ends it", () => {
    holdSelection();
    holdSelection();
    letGo();
    expect(refused()).toBe(false);
    expect(held()).toBe(false);
  });

  it("can be held again after it ended", () => {
    holdSelection();
    letGo();
    holdSelection();
    expect(refused()).toBe(true);
  });

  it("a release nobody was holding for changes nothing", () => {
    letGo();
    letGo("blur");
    expect(refused()).toBe(false);
    expect(held()).toBe(false);
  });
});

describe("passedThreshold", () => {
  it("is false for small moves", () => {
    expect(passedThreshold(0, 0, 2, 2)).toBe(false);
  });
  it("is true once the distance reaches the threshold", () => {
    expect(passedThreshold(0, 0, 5, 0)).toBe(true);
    expect(passedThreshold(10, 10, 13, 14)).toBe(true); // 3-4-5 triangle
  });
  it("respects a custom threshold", () => {
    expect(passedThreshold(0, 0, 0, 4, 5)).toBe(false);
    expect(passedThreshold(0, 0, 0, 6, 5)).toBe(true);
  });
});

describe("dropTargetAt", () => {
  // jsdom doesn't implement elementFromPoint, so we provide it directly.
  it("returns the [data-drop] value under the point", () => {
    document.body.innerHTML = `<div data-drop="Prod" id="t"></div>`;
    const el = document.getElementById("t")!;
    document.elementFromPoint = () => el;
    expect(dropTargetAt(10, 10)).toBe("Prod");
  });
  it("returns null when nothing matches", () => {
    document.elementFromPoint = () => null;
    expect(dropTargetAt(0, 0)).toBeNull();
  });
});

describe("resizableHandle action", () => {
  it("reports deltas between pointerdown and pointerup", () => {
    const node = document.createElement("div");
    node.setPointerCapture = vi.fn();
    node.releasePointerCapture = vi.fn();
    document.body.appendChild(node);

    const onResize = vi.fn();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const handle = resizableHandle(node, { onResize, onStart, onEnd });

    node.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 100, clientY: 50, pointerId: 1 }),
    );
    expect(onStart).toHaveBeenCalledOnce();
    node.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 130, clientY: 38, pointerId: 1 }),
    );
    // Both axes: columns resize by dx, the bottom dock by dy.
    expect(onResize).toHaveBeenCalledWith(30, -12);
    node.dispatchEvent(new PointerEvent("pointerup", { clientX: 130, pointerId: 1 }));
    expect(onEnd).toHaveBeenCalledOnce();

    // After release, moves are ignored.
    onResize.mockClear();
    node.dispatchEvent(new PointerEvent("pointermove", { clientX: 200, pointerId: 1 }));
    expect(onResize).not.toHaveBeenCalled();

    handle.destroy();
  });

  it("holds the selection from the press to the release", () => {
    const node = document.createElement("div");
    node.setPointerCapture = vi.fn();
    node.releasePointerCapture = vi.fn();
    document.body.appendChild(node);
    const handle = resizableHandle(node, { onResize: vi.fn() });
    const held = () => document.documentElement.classList.contains(DRAGGING_CLASS);

    node.dispatchEvent(new PointerEvent("pointerdown", { clientX: 0, pointerId: 1, bubbles: true }));
    expect(held()).toBe(true);
    node.dispatchEvent(new PointerEvent("pointermove", { clientX: 40, pointerId: 1, bubbles: true }));
    expect(held()).toBe(true);
    node.dispatchEvent(new PointerEvent("pointerup", { clientX: 40, pointerId: 1, bubbles: true }));
    expect(held()).toBe(false);

    handle.destroy();
  });
});

describe("layoutBox", () => {
  it("is the element's slot in the layout, wherever a transform draws it", () => {
    const parent = document.createElement("div");
    const el = document.createElement("div");
    parent.appendChild(el);
    document.body.appendChild(parent);
    parent.getBoundingClientRect = () => ({ left: 200, top: 50, width: 400, height: 30 }) as DOMRect;
    Object.defineProperties(parent, {
      clientLeft: { value: 1 },
      clientTop: { value: 1 },
      scrollLeft: { value: 20, writable: true },
      scrollTop: { value: 0, writable: true },
    });
    Object.defineProperties(el, {
      offsetParent: { value: parent },
      offsetLeft: { value: 120 },
      offsetTop: { value: 4 },
      offsetWidth: { value: 80 },
      offsetHeight: { value: 24 },
    });
    // Mid-slide: drawn 120px away from the slot it already holds.
    el.getBoundingClientRect = () => ({ left: 421, top: 55, width: 80, height: 24 }) as DOMRect;
    // parent edge + its border + the offset − what the parent has scrolled.
    expect(layoutBox(el)).toEqual({ left: 301, top: 55, width: 80, height: 24 });
  });

  it("falls back to the drawn box for an element with no offset parent", () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ left: 7, top: 9, width: 30, height: 12 }) as DOMRect;
    expect(layoutBox(el)).toEqual({ left: 7, top: 9, width: 30, height: 12 });
  });
});

describe("glide", () => {
  const rect = (left: number, top: number, width = 80) => ({ left, top, width, height: 30 }) as DOMRect;
  const node = document.createElement("div");

  it("starts where the tab was and ends in its new slot", () => {
    const a = glide(node, { from: rect(200, 10), to: rect(80, 10) }, { duration: 120 });
    expect(a.duration).toBe(120);
    expect(a.css(0, 1)).toBe("transform: translate(120px, 0px)");
    expect(a.css(1, 0)).toBe("transform: translate(0px, 0px)");
  });

  it("moves along the rail's axis too", () => {
    const a = glide(node, { from: rect(0, 40), to: rect(0, 100) }, { duration: 120 });
    expect(a.css(0, 1)).toBe("transform: translate(0px, -60px)");
  });

  it("never scales — a tab that changed width must not squeeze its label", () => {
    const a = glide(node, { from: rect(200, 10, 120), to: rect(80, 10, 60) }, { duration: 120 });
    expect(a.css(0.5, 0.5)).not.toContain("scale");
  });

  it("does not animate a tab that did not move, nor under reduced motion", () => {
    expect(glide(node, { from: rect(80, 10), to: rect(80, 10) }, { duration: 120 }).duration).toBe(0);
    expect(glide(node, { from: rect(200, 10), to: rect(80, 10) }, { duration: 0 }).duration).toBe(0);
    expect(glide(node, { from: rect(200, 10), to: rect(80, 10) }).duration).toBe(0);
  });

  it("eases out: fast off the mark, settling at the end", () => {
    const { easing } = glide(node, { from: rect(200, 10), to: rect(80, 10) }, { duration: 120 });
    expect(easing(0)).toBe(0);
    expect(easing(1)).toBe(1);
    expect(easing(0.5)).toBeGreaterThan(0.5);
  });
});

describe("slotIndex", () => {
  // Two other tabs: 0…100 and 100…300 (a wide one).
  const others = [
    { start: 0, size: 100 },
    { start: 100, size: 200 },
  ];

  it("counts the tabs whose middle the pointer has passed", () => {
    expect(slotIndex(10, others)).toBe(0);
    expect(slotIndex(60, others)).toBe(1);
    expect(slotIndex(190, others)).toBe(1);
    expect(slotIndex(210, others)).toBe(2);
    expect(slotIndex(999, others)).toBe(2);
    expect(slotIndex(50, [])).toBe(0);
  });

  it("holds still after a swap with a wider neighbour", () => {
    // A (100 wide) is dragged right over B (200 wide): A 0…100, B 100…300.
    const before = [{ start: 100, size: 200 }];
    expect(slotIndex(205, before)).toBe(1);
    // They swap: B 0…200, A 200…300. The pointer has not moved — and is now over
    // B again. "Whichever tab is under the pointer" would swap them straight back.
    const after = [{ start: 0, size: 200 }];
    expect(slotIndex(205, after)).toBe(1);
    // Going back takes crossing B's new middle, not just touching B.
    expect(slotIndex(150, after)).toBe(1);
    expect(slotIndex(95, after)).toBe(0);
    // …after which the order is stable again from the other side.
    expect(slotIndex(95, before)).toBe(0);
  });
});
