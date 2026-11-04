import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmptyTier } from "../ui/emptytier";
import { emptyFit } from "./emptyfit";

/** What each tier needs, px — jsdom has no layout, the test gives it one. */
const NEEDS: Record<EmptyTier, number> = { full: 200, medal: 120, line: 70, title: 30 };

type Observer = { cb: ResizeObserverCallback; observe: (el: Element) => void };
const observers = () =>
  (globalThis.ResizeObserver as unknown as { instances: Observer[] }).instances;

/** An empty state's root `room` px tall whose content needs `NEEDS[tier]`. */
function root(room: number) {
  const node = document.createElement("div");
  node.append(document.createElement("div"));
  const geometry = { room };
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => geometry.room });
  Object.defineProperty(node, "scrollHeight", {
    configurable: true,
    get: () => Math.max(geometry.room, NEEDS[node.dataset.tier as EmptyTier] ?? 0),
  });
  return { node, geometry };
}

/** Fire the action's observer as the browser would, for `target`. */
const report = (target: Element) =>
  observers().at(-1)!.cb([{ target } as ResizeObserverEntry], {} as ResizeObserver);

describe("emptyFit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("takes the roomiest tier that fits at mount", () => {
    for (const [room, tier] of [
      [400, "full"],
      [200, "full"],
      [150, "medal"],
      [90, "line"],
      [40, "title"],
      [10, "title"],
    ] as const) {
      const { node } = root(room);
      emptyFit(node).destroy();
      expect(node.dataset.tier, `${room}px`).toBe(tier);
    }
  });

  it("re-fits at once when its own room changes — both ways", () => {
    const { node, geometry } = root(400);
    const action = emptyFit(node);
    geometry.room = 100;
    report(node);
    expect(node.dataset.tier).toBe("line");
    geometry.room = 300;
    report(node);
    expect(node.dataset.tier).toBe("full");
    action.destroy();
  });

  it("watches its content too, and fits a change there on the next frame", () => {
    vi.useFakeTimers();
    const { node, geometry } = root(400);
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    const action = emptyFit(node);
    expect(observe.mock.calls.map(([el]) => el)).toEqual([node, node.firstElementChild]);

    geometry.room = 100;
    report(node.firstElementChild!);
    // Not inside the observer's callback: fitting there would resize the very
    // element that reported, a resize loop.
    expect(node.dataset.tier).toBe("full");
    vi.advanceTimersToNextFrame();
    expect(node.dataset.tier).toBe("line");
    action.destroy();
  });

  it("re-fits when what it says changes, once per frame", () => {
    vi.useFakeTimers();
    const { node, geometry } = root(400);
    const action = emptyFit(node, ["Title", "hint"]);
    geometry.room = 100;
    action.update();
    action.update();
    expect(node.dataset.tier).toBe("full");
    const frames = vi.spyOn(globalThis, "requestAnimationFrame");
    action.update();
    expect(frames).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(node.dataset.tier).toBe("line");
    action.destroy();
  });

  it("an observer call that names nothing is a resize of its own", () => {
    const { node, geometry } = root(400);
    const action = emptyFit(node);
    geometry.room = 40;
    observers().at(-1)!.cb([], {} as ResizeObserver);
    expect(node.dataset.tier).toBe("title");
    action.destroy();
  });

  it("stops watching and drops a pending fit when it goes", () => {
    vi.useFakeTimers();
    const { node, geometry } = root(400);
    const action = emptyFit(node);
    const observer = observers().at(-1) as unknown as { disconnect: () => void };
    const disconnect = vi.spyOn(observer, "disconnect");
    geometry.room = 100;
    action.update();
    action.destroy();
    vi.advanceTimersToNextFrame();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(node.dataset.tier).toBe("full");
  });
});
