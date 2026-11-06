import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutFor, type EmptyTier } from "../ui/emptytier";
import { MOTION_BASE } from "../ui/motion";
import { EMPTY_STYLE, EMPTY_VARS, cssValue, emptyFit } from "./emptyfit";
import { GLIDE_EASING } from "./fluidglide";

// jsdom has no layout; the test lays the empty state out the way the CSS does:
// the badge's row `--empty-badge` tall and only in the `badge` tier, the text under
// it `--empty-gap` apart, the hint cut to two lines with `data-clamp`, the actions
// under the text (`--empty-cta` above them) or beside the title.

const TITLE = 20;
const LINE = 16;
const BUTTON = 28;

type Observer = { cb: ResizeObserverCallback; disconnect?: () => void };
const observers = () =>
  (globalThis.ResizeObserver as unknown as { instances: Observer[] }).instances;

function stateOf(room: number, { hintLines = 2, actions = true } = {}) {
  const geometry = { room };
  const node = document.createElement("div");
  const column = document.createElement("div");
  const badge = document.createElement("div");
  badge.setAttribute("data-empty-badge", "");
  const circle = document.createElement("span");
  circle.setAttribute("data-empty-icon", "badge");
  const glyph = document.createElement("span");
  glyph.setAttribute("data-empty-glyph", "");
  circle.append(glyph);
  badge.append(circle);
  const text = document.createElement("div");
  const lineIcon = document.createElement("span");
  lineIcon.setAttribute("data-empty-icon", "line");
  text.append(lineIcon);
  if (actions) {
    const cta = document.createElement("div");
    cta.setAttribute("data-empty-actions", "");
    text.append(cta);
  }
  column.append(badge, text);
  node.append(column);

  const px = (name: string) => parseFloat(node.style.getPropertyValue(name)) * 16 || 0;
  const tier = () => node.dataset.tier as EmptyTier;
  const hint = () => (hintLines ? (tier() === "badge" && node.dataset.clamp === undefined ? hintLines : Math.min(2, hintLines)) * LINE : 0);
  const height = (el: HTMLElement): number => {
    if (el === badge) return tier() === "badge" ? px(EMPTY_VARS.badge) : 0;
    if (tier() === "badge") return TITLE + (hintLines ? 4 + hint() : 0) + (actions ? px(EMPTY_VARS.cta) + BUTTON : 0);
    const row = actions ? BUTTON : TITLE;
    return tier() === "line" && hintLines ? row + 2 + hint() : row;
  };
  const tops = () => {
    let y = px(EMPTY_VARS.padY);
    return [badge, text].map((el) => {
      const top = y;
      if (height(el)) y += height(el) + px(EMPTY_VARS.gap);
      return top;
    });
  };
  const needed = () => tops()[1] + height(text) + px(EMPTY_VARS.padY);

  for (const [i, el] of [badge, text].entries()) {
    Object.defineProperty(el, "offsetHeight", { get: () => Math.round(height(el)) });
    Object.defineProperty(el, "offsetTop", { get: () => Math.round(tops()[i]) });
  }
  Object.defineProperty(node, "clientHeight", { get: () => geometry.room });
  Object.defineProperty(node, "scrollHeight", { get: () => Math.max(geometry.room, Math.round(needed())) });
  // Where the icons are: the badge's at the middle, the title row's at its left.
  glyph.getBoundingClientRect = () => ({ left: 111, top: 20, width: 18, height: 18 }) as DOMRect;
  lineIcon.getBoundingClientRect = () => ({ left: 40, top: 12, width: 16, height: 16 }) as DOMRect;
  for (const [el, x, y, w] of [
    [lineIcon, 40, 12, 16],
    [circle, 102, 8, 36],
  ] as const) {
    Object.defineProperty(el, "offsetLeft", { get: () => x });
    Object.defineProperty(el, "offsetTop", { get: () => y });
    Object.defineProperty(el, "offsetWidth", { get: () => w });
    Object.defineProperty(el, "offsetHeight", { get: () => w });
  }
  return { node, geometry, badge, text, circle, lineIcon };
}

/** Height the badge tier needs at `k` — two-line hint, actions under it. */
const need = (k: number, { hintLines = 2, actions = true } = {}) => {
  const l = layoutFor("badge", k);
  const text = TITLE + (hintLines ? 4 + Math.min(2, hintLines) * LINE : 0) + (actions ? l.cta + BUTTON : 0);
  return 2 * l.padY + l.badge + l.gap + text;
};

const report = (target: Element) =>
  observers().at(-1)!.cb([{ target } as ResizeObserverEntry], {} as ResizeObserver);

/** An `animate` that records what it is asked. */
function record(el: HTMLElement) {
  const animate = vi.fn(() => ({ cancel: vi.fn(), playState: "running" }) as unknown as Animation);
  Object.defineProperty(el, "animate", { value: animate, configurable: true });
  return animate;
}

const ringOf = (node: HTMLElement) => node.style.getPropertyValue(EMPTY_VARS.badge);

describe("emptyFit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts, before it has measured, in the roomiest layout", () => {
    const full = layoutFor("badge", 1);
    for (const key of Object.keys(EMPTY_VARS) as (keyof typeof EMPTY_VARS)[]) {
      expect(EMPTY_STYLE).toContain(`${EMPTY_VARS[key]}: ${cssValue(key, full[key])}`);
    }
  });

  it("draws the full badge, the hint whole, when there is room", () => {
    const { node } = stateOf(400, { hintLines: 4 });
    emptyFit(node).destroy();
    expect(node.dataset.tier).toBe("badge");
    expect(node.dataset.clamp).toBeUndefined();
    expect(ringOf(node)).toBe("3.5rem");
    expect(node.style.getPropertyValue(EMPTY_VARS.lines)).toBe("0");
  });

  it("cuts a long hint to two lines before the badge starts to shrink", () => {
    const { node } = stateOf(need(1) + 10, { hintLines: 4 });
    emptyFit(node).destroy();
    expect(node.dataset.clamp).toBe("");
    expect(ringOf(node)).toBe("3.5rem");
  });

  it("shrinks the badge with the room and grows the lines out of it", () => {
    const { node } = stateOf(need(0.5));
    emptyFit(node).destroy();
    expect(node.dataset.tier).toBe("badge");
    expect(ringOf(node)).toBe(cssValue("badge", layoutFor("badge", 0.5).badge));
    expect(node.style.getPropertyValue(EMPTY_VARS.lines)).toBe("0.5");
  });

  it("gives up the badge short of the medallion, then the hint", () => {
    for (const [room, tier] of [
      [need(0), "badge"],
      [need(0) - 1, "line"],
      [2 * 6 + BUTTON + 2 + 2 * LINE, "line"],
      [2 * 6 + BUTTON + 2 + 2 * LINE - 1, "title"],
      [10, "title"],
    ] as const) {
      const { node } = stateOf(room);
      emptyFit(node).destroy();
      expect(node.dataset.tier, `${room}px`).toBe(tier);
    }
  });

  it("re-fits at once when its own room changes — both ways", () => {
    const { node, geometry } = stateOf(400);
    const action = emptyFit(node);
    geometry.room = 30;
    report(node);
    expect(node.dataset.tier).toBe("title");
    geometry.room = 400;
    report(node);
    expect(node.dataset.tier).toBe("badge");
    expect(ringOf(node)).toBe("3.5rem");
    action.destroy();
  });

  it("an observer call that names nothing is a resize of its own", () => {
    const { node, geometry } = stateOf(400);
    const action = emptyFit(node);
    geometry.room = 30;
    observers().at(-1)!.cb([], {} as ResizeObserver);
    expect(node.dataset.tier).toBe("title");
    action.destroy();
  });

  it("does not move anything on mount", () => {
    const { node, badge, text, lineIcon, circle } = stateOf(need(0.2));
    const calls = [badge, text, lineIcon, circle].map(record);
    emptyFit(node).destroy();
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });

  it("flies the badge's icon into the title's row when the badge gives way", () => {
    const { node, geometry, text, lineIcon } = stateOf(400);
    const action = emptyFit(node);
    const row = record(text);
    const icon = record(lineIcon);
    geometry.room = 80;
    report(node);
    expect(node.dataset.tier).toBe("line");

    // The text's row glides up from under the badge.
    const [rowFrames] = row.mock.calls[0] as unknown as [Keyframe[]];
    const rowShift = Number(/translateY\((-?[\d.]+)px\)/.exec(String(rowFrames[0].transform))![1]);
    expect(rowShift).toBeGreaterThan(0);
    // The icon starts where the badge drew it — its row carries the rest of the way.
    const [frames, timing] = icon.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(timing).toEqual({ duration: MOTION_BASE, easing: GLIDE_EASING });
    expect(frames.at(-1)).toEqual({ transform: "none" });
    const [, dx, dy, scale] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/
      .exec(String(frames[0].transform))!
      .map(Number);
    expect(dx).toBe(111 + 9 - (40 + 8));
    expect(dy + rowShift).toBe(20 + 9 - (12 + 8));
    expect(scale).toBeCloseTo(18 / 16, 9);
    action.destroy();
  });

  it("grows the circle out of the title's icon when there is room again", () => {
    const { node, geometry, badge, circle } = stateOf(80);
    const action = emptyFit(node);
    expect(node.dataset.tier).toBe("line");
    const row = record(badge);
    const ring = record(circle);
    geometry.room = need(0);
    report(node);
    expect(node.dataset.tier).toBe("badge");
    // The badge's row fades in; the circle starts as small as the icon was, where it was.
    expect((row.mock.calls[0] as unknown as [Keyframe[]])[0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    const [frames] = ring.mock.calls[0] as unknown as [Keyframe[]];
    expect(String(frames[0].transform)).toBe(
      `translate(${40 + 8 - (102 + 18)}px, ${12 + 8 - (8 + 18)}px) scale(${16 / 36})`,
    );
    action.destroy();
  });

  it("places everything at once with reduced motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { node, geometry, text, lineIcon } = stateOf(400);
    const action = emptyFit(node);
    const calls = [text, lineIcon].map(record);
    geometry.room = 80;
    report(node);
    expect(node.dataset.tier).toBe("line");
    for (const c of calls) expect(c).not.toHaveBeenCalled();
    action.destroy();
  });

  it("watches its content too, and fits a change there on the next frame", () => {
    vi.useFakeTimers();
    const { node, geometry } = stateOf(400);
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    const action = emptyFit(node);
    expect(observe.mock.calls.map(([el]) => el)).toEqual([node, node.firstElementChild]);
    geometry.room = 80;
    report(node.firstElementChild!);
    expect(node.dataset.tier).toBe("badge");
    vi.advanceTimersToNextFrame();
    expect(node.dataset.tier).toBe("line");
    action.destroy();
  });

  it("re-fits when what it says changes, once per frame", () => {
    vi.useFakeTimers();
    const { node, geometry } = stateOf(400);
    const action = emptyFit(node, ["Title", "hint"]);
    geometry.room = 80;
    action.update();
    action.update();
    expect(node.dataset.tier).toBe("badge");
    const frames = vi.spyOn(globalThis, "requestAnimationFrame");
    action.update();
    expect(frames).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(node.dataset.tier).toBe("line");
    action.destroy();
  });

  it("stops watching and drops a pending fit when it goes", () => {
    vi.useFakeTimers();
    const { node, geometry } = stateOf(400);
    const action = emptyFit(node);
    const observer = observers().at(-1) as unknown as { disconnect: () => void };
    const disconnect = vi.spyOn(observer, "disconnect");
    geometry.room = 80;
    action.update();
    action.destroy();
    vi.advanceTimersToNextFrame();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(node.dataset.tier).toBe("badge");
  });
});
