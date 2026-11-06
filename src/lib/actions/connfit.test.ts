import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutFor, ringFit, type ConnMode } from "../connect/connfit";
import { settings } from "../settings/settings.svelte";
import { MOTION_BASE } from "../ui/motion";
import { CONN_VARS, connFit, cssValue } from "./connfit";
import { GLIDE_EASING } from "./fluidglide";

// jsdom has no layout; the test lays the screen out the way the CSS does: the
// blocks one under another, `--conn-*` apart, the ring `--conn-ring` across and
// only in the `ring` mode, the checklist gone in `title`.

/** Heights of the blocks at 100 %: title, checklist, buttons. */
const TITLE = 20;
const STEPS = 88;
const BUTTONS = 24;

type Observer = { cb: ResizeObserverCallback };
const observers = () =>
  (globalThis.ResizeObserver as unknown as { instances: Observer[] }).instances;

function screenOf(room: number, withButtons = false) {
  const geometry = { room, scale: 1 };
  const node = document.createElement("div");
  const column = document.createElement("div");
  node.append(column);
  const block = (height: number, ring = false) => {
    const el = document.createElement("div");
    if (ring) el.setAttribute("data-conn-ring", "");
    (el as unknown as { h: number }).h = height;
    column.append(el);
    return el;
  };
  const ring = block(0, true);
  const title = block(TITLE);
  const steps = block(STEPS);
  const blocks = withButtons ? [ring, title, steps, block(BUTTONS)] : [ring, title, steps];

  const px = (name: string) =>
    parseFloat(node.style.getPropertyValue(name)) * 16 * geometry.scale || 0;
  const mode = () => node.dataset.mode as ConnMode;
  const shown = (el: HTMLElement) =>
    el === ring ? mode() === "ring" : el === steps ? mode() !== "title" : true;
  const height = (el: HTMLElement) =>
    !shown(el) ? 0 : el === ring ? px(CONN_VARS.ring) : (el as unknown as { h: number }).h * geometry.scale;
  const tops = () => {
    let y = px(CONN_VARS.padY);
    return blocks.map((el) => {
      const top = y;
      if (shown(el)) y += height(el) + px(CONN_VARS.gap);
      return top;
    });
  };
  const needed = () => tops().at(-1)! + height(blocks.at(-1)!) + px(CONN_VARS.padY);

  for (const [i, el] of blocks.entries()) {
    Object.defineProperty(el, "offsetHeight", { get: () => Math.round(height(el)) });
    Object.defineProperty(el, "offsetTop", { get: () => Math.round(tops()[i]) });
  }
  Object.defineProperty(node, "clientHeight", { get: () => geometry.room });
  Object.defineProperty(node, "scrollHeight", {
    get: () => Math.max(geometry.room, Math.round(needed())),
  });
  return { node, geometry, ring, title, steps, blocks };
}

/** Fire the action's observer as the browser would, for `target`. */
const report = (target: Element) =>
  observers().at(-1)!.cb([{ target } as ResizeObserverEntry], {} as ResizeObserver);

/** Height today's screen needs at `k` — direct connection, two gaps. */
const need = (k: number) => {
  const l = layoutFor("ring", k);
  return 2 * l.padY + l.ring + 2 * l.gap + TITLE + STEPS;
};

/** An `animate` that records its glides and keeps them running. */
function recordGlides(el: HTMLElement) {
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel, playState: "running" }) as unknown as Animation);
  Object.defineProperty(el, "animate", { value: animate, configurable: true });
  return { animate, cancel };
}

describe("connFit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    settings.uiScale = 100;
  });

  it("draws today's screen when there is room for it", () => {
    const { node } = screenOf(400);
    connFit(node).destroy();
    expect(node.dataset.mode).toBe("ring");
    const today = layoutFor("ring", 1);
    for (const key of Object.keys(CONN_VARS) as (keyof typeof CONN_VARS)[]) {
      expect(node.style.getPropertyValue(CONN_VARS[key])).toBe(cssValue(key, today[key]));
    }
    expect(node.style.getPropertyValue(CONN_VARS.ring)).toBe("4rem");
  });

  it("shrinks the ring with the room — one size for both sides, so a circle", () => {
    const { node } = screenOf(need(0.5));
    connFit(node).destroy();
    expect(node.dataset.mode).toBe("ring");
    expect(node.style.getPropertyValue(CONN_VARS.ring)).toBe(cssValue("ring", layoutFor("ring", 0.5).ring));
    expect(node.style.getPropertyValue(CONN_VARS.gap)).toBe(cssValue("gap", layoutFor("ring", 0.5).gap));
  });

  it("gives up the ring short of the smallest one, then folds the checklist", () => {
    for (const [room, mode] of [
      [need(0), "ring"],
      [need(0) - 1, "line"],
      [8 + TITLE + 10 + STEPS + 8, "line"],
      [8 + TITLE + 10 + STEPS + 7, "title"],
      [20, "title"],
    ] as const) {
      const { node } = screenOf(room);
      connFit(node).destroy();
      expect(node.dataset.mode, `${room}px`).toBe(mode);
    }
  });

  it("counts the buttons under the checklist", () => {
    const room = need(0.5);
    const plain = screenOf(room);
    const failed = screenOf(room, true);
    connFit(plain.node).destroy();
    connFit(failed.node).destroy();
    expect(parseFloat(failed.node.style.getPropertyValue(CONN_VARS.ring))).toBeLessThan(
      parseFloat(plain.node.style.getPropertyValue(CONN_VARS.ring)),
    );
  });

  it("measures at 100 %: the same screen at another interface scale fits the same", () => {
    const at100 = screenOf(need(0.3));
    connFit(at100.node).destroy();
    settings.uiScale = 125;
    const at125 = screenOf(need(0.3) * 1.25);
    at125.geometry.scale = 1.25;
    connFit(at125.node).destroy();
    expect(at125.node.style.getPropertyValue(CONN_VARS.ring)).toBe(
      at100.node.style.getPropertyValue(CONN_VARS.ring),
    );
    expect(ringFit(need(0.3), TITLE + STEPS, 2)).toBeCloseTo(0.3, 9);
  });

  it("re-fits at once when its own room changes — both ways", () => {
    const { node, geometry } = screenOf(400);
    const action = connFit(node);
    geometry.room = 100;
    report(node);
    expect(node.dataset.mode).toBe("title");
    geometry.room = 400;
    report(node);
    expect(node.dataset.mode).toBe("ring");
    expect(node.style.getPropertyValue(CONN_VARS.ring)).toBe("4rem");
    action.destroy();
  });

  it("does not glide on mount", () => {
    const { node, blocks } = screenOf(need(0.5));
    const glides = blocks.map(recordGlides);
    connFit(node).destroy();
    for (const g of glides) expect(g.animate).not.toHaveBeenCalled();
  });

  it("glides each moved block from where it was drawn — transform only, timed by motion", () => {
    const { node, geometry, ring, title } = screenOf(400);
    const action = connFit(node);
    const ringGlide = recordGlides(ring);
    const titleGlide = recordGlides(title);

    geometry.room = need(0); // a split halves the pane
    report(node);

    expect(ringGlide.animate).toHaveBeenCalledTimes(1);
    expect(titleGlide.animate).toHaveBeenCalledTimes(1);
    for (const glide of [ringGlide, titleGlide]) {
      const [frames, timing] = glide.animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
      for (const frame of frames) expect(Object.keys(frame)).toEqual(["transform"]);
      expect(frames.at(-1)).toEqual({ transform: "none" });
      expect(timing).toEqual({ duration: MOTION_BASE, easing: GLIDE_EASING });
    }
    // The ring starts at the size it was drawn (64 → 32 px: twice the new one).
    const [[ringFrom]] = ringGlide.animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(ringFrom.transform).toMatch(/scale\(2\)$/);
    // The title only moves: it is no bigger than it was.
    const [[titleFrom]] = titleGlide.animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(titleFrom.transform).toMatch(/^translateY\(\d+(\.\d+)?px\) scale\(1\)$/);
    action.destroy();
  });

  it("fades in the ring when there is room for it again — opacity only", () => {
    const { node, geometry, ring, title } = screenOf(100);
    const action = connFit(node);
    expect(node.dataset.mode).toBe("title");
    const ringGlide = recordGlides(ring);
    const titleGlide = recordGlides(title);

    geometry.room = 400;
    report(node);

    expect(node.dataset.mode).toBe("ring");
    expect(ringGlide.animate).toHaveBeenCalledTimes(1);
    const [frames, timing] = ringGlide.animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(timing).toEqual({ duration: MOTION_BASE, easing: GLIDE_EASING });
    // The title, drawn all along, glides to its new place instead.
    const [[titleFrom]] = titleGlide.animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(Object.keys(titleFrom)).toEqual(["transform"]);
    action.destroy();
  });

  it("lets a glide run on when its block is laid where it was", () => {
    vi.useFakeTimers();
    const { node, geometry, ring } = screenOf(400);
    const action = connFit(node);
    const glide = recordGlides(ring);
    geometry.room = need(0.2);
    report(node);
    expect(glide.animate).toHaveBeenCalledTimes(1);

    // The column reports the size the fit gave it: nothing moved, nothing restarts.
    report(node.firstElementChild!);
    vi.advanceTimersToNextFrame();
    expect(glide.animate).toHaveBeenCalledTimes(1);
    expect(glide.cancel).not.toHaveBeenCalled();
    action.destroy();
  });

  it("places at once with reduced motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { node, geometry, ring } = screenOf(400);
    const action = connFit(node);
    const glide = recordGlides(ring);
    geometry.room = need(0);
    report(node);
    expect(glide.animate).not.toHaveBeenCalled();
    expect(node.style.getPropertyValue(CONN_VARS.ring)).toBe(cssValue("ring", 32));
    action.destroy();
  });

  it("re-fits when what it says changes, once per frame", () => {
    vi.useFakeTimers();
    const { node, geometry } = screenOf(400);
    const action = connFit(node);
    geometry.room = 100;
    action.update();
    action.update();
    expect(node.dataset.mode).toBe("ring");
    vi.advanceTimersToNextFrame();
    expect(node.dataset.mode).toBe("title");
    action.destroy();
  });
});
