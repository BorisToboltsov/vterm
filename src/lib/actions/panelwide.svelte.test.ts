import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settings } from "../settings/settings.svelte";
import { wideWhen } from "./panelwide.svelte";

describe("wideWhen", () => {
  /** The latest observer the action made, with a way to fire it. */
  const observers = () =>
    (globalThis.ResizeObserver as unknown as { instances: { cb: () => void }[] }).instances;
  const sized = (node: HTMLElement, width: number) =>
    Object.defineProperty(node, "clientWidth", { configurable: true, value: width });
  const resize = (node: HTMLElement, width: number) => {
    sized(node, width);
    observers().at(-1)?.cb();
  };
  /** The action in the effect scope `use:` gives it; `stop` ends that scope. */
  function mount(node: HTMLElement, onchange: (wide: boolean) => void) {
    let action!: ReturnType<typeof wideWhen>;
    const stop = $effect.root(() => {
      action = wideWhen(node, onchange);
    });
    flushSync();
    return { action, stop };
  }

  afterEach(() => {
    settings.uiScale = 100;
    flushSync();
    vi.restoreAllMocks();
  });

  it("reports the layout at mount, then only when the threshold is crossed", () => {
    const node = document.createElement("div");
    const seen: boolean[] = [];
    const { action, stop } = mount(node, (wide) => seen.push(wide));
    expect(seen).toEqual([false]);
    resize(node, 400);
    resize(node, 700);
    expect(seen).toEqual([false]);
    resize(node, 900);
    resize(node, 1200);
    expect(seen).toEqual([false, true]);
    resize(node, 500);
    expect(seen).toEqual([false, true, false]);
    action.destroy();
    stop();
  });

  it("shows the panel anew when it crosses the threshold — not at mount, not on a resize that stays", async () => {
    const node = document.createElement("div");
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null, oncancel: null }) as unknown as Animation);
    Object.defineProperty(node, "animate", { value: animate, configurable: true });
    const { action, stop } = mount(node, () => {});
    await Promise.resolve();
    resize(node, 600);
    await Promise.resolve();
    expect(animate).not.toHaveBeenCalled();
    resize(node, 1000);
    await Promise.resolve();
    expect(animate).toHaveBeenCalledOnce();
    expect((animate.mock.calls[0] as unknown as [Keyframe[]])[0]).toEqual([{ opacity: 0.35 }, { opacity: 1 }]);
    action.destroy();
    stop();
  });

  it("stops watching when the panel goes", () => {
    const node = document.createElement("div");
    const { action, stop } = mount(node, () => {});
    const observer = observers().at(-1) as unknown as { disconnect: () => void };
    const disconnect = vi.spyOn(observer, "disconnect");
    action.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    stop();
  });

  it("calls the handler it was last given", () => {
    const node = document.createElement("div");
    const first = vi.fn();
    const second = vi.fn();
    const { action, stop } = mount(node, first);
    action.update(second);
    resize(node, 1000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledExactlyOnceWith(true);
    action.destroy();
    stop();
  });

  it("follows the interface scale, which moves the threshold and not the panel", () => {
    const node = document.createElement("div");
    sized(node, 800);
    const seen: boolean[] = [];
    const { action, stop } = mount(node, (wide) => seen.push(wide));
    expect(seen).toEqual([true]);
    // 48rem is 960 px at 125 %: the same 800 px are narrow now, with no resize at all.
    settings.uiScale = 125;
    flushSync();
    expect(seen).toEqual([true, false]);
    action.destroy();
    stop();
  });
});
