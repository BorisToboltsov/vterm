import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wideWhen } from "./actions/panelwide";
import { isWide, WIDE_REM } from "./panelwide";

describe("isWide", () => {
  it("is the container breakpoint: wide from 48rem up", () => {
    expect(isWide(767)).toBe(false);
    expect(isWide(768)).toBe(true);
    expect(isWide(1400)).toBe(true);
    expect(isWide(0)).toBe(false);
  });

  it("follows the root font size, as a container query does", () => {
    expect(isWide(800, 20)).toBe(false);
    expect(isWide(960, 20)).toBe(true);
  });

  it("is narrow for a width it cannot read", () => {
    expect(isWide(Number.NaN)).toBe(false);
    expect(isWide(1000, 0)).toBe(false);
  });

  it("is the same threshold the `@wide:` variants use", () => {
    // One number, two readers: a panel that measures itself and a panel laid out
    // by a container query must switch at the same width.
    const css = readFileSync(join(process.cwd(), "src", "app.css"), "utf8");
    expect(css).toMatch(new RegExp(`--container-wide:\\s*${WIDE_REM}rem;`));
  });
});

describe("wideWhen", () => {
  /** The latest observer the action made, with a way to fire it. */
  const observers = () =>
    (globalThis.ResizeObserver as unknown as { instances: { cb: () => void }[] }).instances;
  const resize = (node: HTMLElement, width: number) => {
    Object.defineProperty(node, "clientWidth", { configurable: true, value: width });
    observers().at(-1)?.cb();
  };

  afterEach(() => vi.restoreAllMocks());

  it("reports the layout at mount, then only when the threshold is crossed", () => {
    const node = document.createElement("div");
    const seen: boolean[] = [];
    const action = wideWhen(node, (wide) => seen.push(wide));
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
  });

  it("stops watching when the panel goes", () => {
    const node = document.createElement("div");
    const action = wideWhen(node, () => {});
    const observer = observers().at(-1) as unknown as { disconnect: () => void };
    const disconnect = vi.spyOn(observer, "disconnect");
    action.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("calls the handler it was last given", () => {
    const node = document.createElement("div");
    const first = vi.fn();
    const second = vi.fn();
    const action = wideWhen(node, first);
    action.update(second);
    resize(node, 1000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledExactlyOnceWith(true);
    action.destroy();
  });
});
