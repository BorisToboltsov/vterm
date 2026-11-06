import { afterEach, describe, expect, it, vi } from "vitest";
import { MOTION_BASE } from "../ui/motion";
import { GLIDE_EASING, aside, createPanelMorph, createRowGlide, gridGlide, viaMore } from "./fluidglide";

// jsdom has no layout: every element here is given the box the test says it has.

type Box = { left: number; top: number; width: number; height: number };
const placed = new WeakMap<Element, Box>();
function place(el: Element, box: Box): void {
  placed.set(el, box);
  (el as HTMLElement).getBoundingClientRect = () => {
    const b = placed.get(el)!;
    return { ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height } as DOMRect;
  };
}
const at = (left: number, width = 20, top = 0, height = 20): Box => ({ left, top, width, height });

/** An `animate` that records what it is asked, and a promise for its end. */
function record(el: HTMLElement) {
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const anim = { cancel: vi.fn(), finished, onfinish: null, oncancel: null, playState: "running" };
  const animate = vi.fn((..._args: unknown[]) => anim as unknown as Animation);
  Object.defineProperty(el, "animate", { value: animate, configurable: true });
  return { animate, finish: () => finish() };
}

function item(key: string): HTMLElement {
  const el = document.createElement("button");
  el.dataset.rowKey = key;
  el.dataset.testid = `t-${key}`;
  el.textContent = key;
  return el;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("createRowGlide", () => {
  function row() {
    const el = document.createElement("div");
    document.body.append(el);
    place(el, at(100, 300));
    const a = item("a");
    const b = item("b");
    const c = item("c");
    el.append(a, b, c);
    place(a, at(100));
    place(b, at(130));
    place(c, at(160));
    return { el, a, b, c };
  }

  it("glides what stays, flies what leaves into «⋯» as a picture of itself", async () => {
    const { el, b, c } = row();
    const glide = createRowGlide(() => el, { more: "more" });
    glide.snapshot();
    // `b` goes into «⋯»; `c` takes its place, «⋯» stands after it.
    b.remove();
    const more = item("more");
    el.append(more);
    place(c, at(130));
    place(more, at(160, 16));
    const moved = record(c);
    const shown = record(more);
    let picture: HTMLElement | null = null;
    const append = document.body.append.bind(document.body);
    vi.spyOn(document.body, "append").mockImplementation((...nodes) => {
      picture = nodes[0] as HTMLElement;
      record(picture);
      append(...nodes);
    });
    glide.play();

    expect(moved.animate).toHaveBeenCalledWith(
      [{ transform: "translate(30px, 0px)" }, { transform: "none" }],
      { duration: MOTION_BASE, easing: GLIDE_EASING },
    );
    // «⋯» itself only fades in.
    expect(shown.animate.mock.calls[0][0]).toEqual([
      { transform: "scale(0.6)", opacity: 0 },
      { transform: "none", opacity: 1 },
    ]);
    // The picture stands where `b` stood, unseen by tests and readers, and flies into «⋯».
    const pic = picture as unknown as HTMLElement;
    expect(pic.style.position).toBe("fixed");
    expect(pic.style.left).toBe("130px");
    expect(pic.getAttribute("aria-hidden")).toBe("true");
    expect(pic.dataset.testid).toBeUndefined();
    const [frames] = (pic.animate as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [Keyframe[]];
    expect(frames[1]).toEqual({ transform: `translate(${168 - 140}px, 0px) scale(${16 / 20})`, opacity: 0 });
    expect(document.body.contains(pic)).toBe(true);
  });

  it("brings what comes back out of «⋯»", () => {
    const { el, b, c } = row();
    b.remove();
    const more = item("more");
    el.append(more);
    place(c, at(130));
    place(more, at(160, 16));
    const glide = createRowGlide(() => el, { more: "more" });
    glide.snapshot();
    el.insertBefore(b, c);
    more.remove();
    place(b, at(130));
    place(c, at(160));
    const back = record(b);
    glide.play();
    const [frames] = back.animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(frames[0]).toEqual({ transform: `translate(${168 - 140}px, 0px) scale(${16 / 20})`, opacity: 0 });
  });

  it("counts what is not shown as gone", () => {
    const { el, b } = row();
    const glide = createRowGlide(() => el);
    glide.snapshot();
    b.setAttribute("aria-hidden", "true");
    const spy = vi.spyOn(document.body, "append");
    glide.play();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("does nothing with reduced motion, or for a row it did not see", () => {
    const { el, b, c } = row();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const glide = createRowGlide(() => el);
    glide.snapshot();
    b.remove();
    place(c, at(130));
    const moved = record(c);
    glide.play();
    expect(moved.animate).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const other = document.createElement("div");
    let current: HTMLElement = el;
    const switching = createRowGlide(() => current);
    switching.snapshot();
    current = other;
    switching.play();
    expect(moved.animate).not.toHaveBeenCalled();
  });
});

describe("viaMore", () => {
  it("runs a button between its place and «⋯», shrinking to it", () => {
    const bar = document.createElement("div");
    const button = document.createElement("div");
    const more = document.createElement("button");
    more.dataset.topbarMore = "";
    bar.append(button, more);
    place(button, at(0, 27));
    place(more, at(100, 27));
    // Deferred: «⋯» is looked for once the change is in the DOM.
    const t = viaMore(button, { duration: 120, more: "[data-topbar-more]" })();
    expect(t.duration).toBe(120);
    expect(t.css(1, 0)).toBe("transform: translate(0px, 0px) scale(1); opacity: 1");
    expect(t.css(0, 1)).toBe("transform: translate(100px, 0px) scale(1); opacity: 0");
  });

  it("brings the last buttons back out of where «⋯» stood, the bar's right end", () => {
    const bar = document.createElement("div");
    const button = document.createElement("div");
    const more = document.createElement("button");
    more.dataset.topbarMore = "";
    bar.append(button, more);
    place(bar, at(0, 300, 0, 27));
    place(button, at(0, 27, 0, 27));
    place(more, at(200, 27, 0, 27));
    viaMore(button, { duration: 120, more: "[data-topbar-more]" })();
    // The bar grew and «⋯» went with the last button back.
    more.remove();
    place(bar, at(0, 500, 0, 27));
    place(button, at(400, 27, 0, 27));
    expect(viaMore(button, { duration: 120, more: "[data-topbar-more]" })().css(0, 1)).toBe(
      "transform: translate(73px, 0px) scale(1); opacity: 0",
    );
  });

  it("shrinks and fades where there is no «⋯»", () => {
    const button = document.createElement("div");
    document.createElement("div").append(button);
    place(button, at(0, 27));
    expect(viaMore(button, { duration: 120, more: "[data-topbar-more]" })().css(0, 1)).toBe(
      "transform: scale(0.6); opacity: 0",
    );
  });
});

describe("aside", () => {
  it("takes a part that goes out of the flow where it stands, so the list takes the room at once", () => {
    const pane = document.createElement("div");
    for (const [k, v] of Object.entries({ offsetLeft: 200, offsetTop: 0, offsetWidth: 180, offsetHeight: 300 })) {
      Object.defineProperty(pane, k, { value: v });
    }
    const t = aside(pane, { duration: 200 }, { direction: "out" });
    expect(pane.style.position).toBe("absolute");
    expect(pane.style.left).toBe("200px");
    expect(pane.style.width).toBe("180px");
    expect(t.css(0, 1)).toBe("transform: translateX(40%); opacity: 0");
  });

  it("leaves a part that comes in where the layout puts it", () => {
    const pane = document.createElement("div");
    aside(pane, { duration: 200 }, { direction: "in" });
    expect(pane.style.position).toBe("");
  });
});

describe("createPanelMorph", () => {
  it("fades the new layout in and glides the lasting blocks from where they stood", () => {
    const panel = document.createElement("div");
    const list = document.createElement("div");
    list.setAttribute("data-morph", "");
    panel.append(list);
    place(panel, at(0, 800, 0, 400));
    place(list, at(0, 800, 40, 360));
    const morph = createPanelMorph(panel);
    morph.record();
    place(list, at(0, 800, 72, 328));
    const fade = record(panel);
    const glide = record(list);
    morph.play();
    expect(fade.animate.mock.calls[0][0]).toEqual([{ opacity: 0.35 }, { opacity: 1 }]);
    expect(glide.animate.mock.calls[0][0]).toEqual([{ transform: "translate(0px, -32px)" }, { transform: "none" }]);
  });
});

describe("gridGlide", () => {
  type Observer = { cb: ResizeObserverCallback };
  const observers = () => (globalThis.ResizeObserver as unknown as { instances: Observer[] }).instances;

  it("glides the cards only when the grid changes its columns", () => {
    const page = document.createElement("div");
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.style.gridTemplateColumns = "1fr 1fr";
    const [a, b] = [document.createElement("div"), document.createElement("div")];
    grid.append(a, b);
    page.append(grid);
    document.body.append(page);
    place(grid, at(0, 600, 0, 200));
    place(a, at(0, 300));
    place(b, at(300, 300));
    const action = gridGlide(page);

    // Wider columns, same count: nothing moves.
    const moveA = record(a);
    const moveB = record(b);
    place(b, at(320, 320));
    observers().at(-1)!.cb([], {} as ResizeObserver);
    expect(moveB.animate).not.toHaveBeenCalled();

    // One column: the second card glides down from beside the first.
    grid.style.gridTemplateColumns = "1fr";
    place(a, at(0, 500, 0, 100));
    place(b, at(0, 500, 108, 100));
    observers().at(-1)!.cb([], {} as ResizeObserver);
    expect(moveA.animate).not.toHaveBeenCalled();
    expect(moveB.animate.mock.calls[0][0]).toEqual([{ transform: "translate(320px, -108px)" }, { transform: "none" }]);
    action.destroy();
  });
});
