import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SplitDivider from "./SplitDivider.svelte";
import type { Divider } from "./splitlayout";

const bounds = { width: 1001, height: 600 };

/** A divider in the middle of a 1001px-wide row split: 500 | 1 | 500. */
const row: Divider = {
  split: "s1",
  dir: "row",
  rect: { x: 500, y: 0, w: 1, h: 600 },
  start: 0,
  avail: 1000,
  ratio: 0.5,
  min: 0.24,
  max: 0.76,
};

const col: Divider = {
  split: "s2",
  dir: "col",
  rect: { x: 0, y: 300, w: 1001, h: 1 },
  start: 0,
  avail: 599,
  ratio: 0.5,
  min: 0.25,
  max: 0.75,
};

function setup(divider: Divider) {
  const onratio = vi.fn();
  render(SplitDivider, { props: { divider, bounds, onratio } });
  const el = screen.getByTestId("split-divider");
  // jsdom implements neither; the resize action captures the pointer on press.
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  return { el, onratio };
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0] as number;

describe("SplitDivider", () => {
  it("is a focusable separator that says where it stands and how far it can go", () => {
    const { el } = setup(row);
    expect(el).toHaveAttribute("role", "separator");
    expect(el).toHaveAttribute("tabindex", "0");
    // A line between two columns is a VERTICAL separator.
    expect(el).toHaveAttribute("aria-orientation", "vertical");
    expect(el).toHaveAttribute("aria-valuenow", "50");
    expect(el).toHaveAttribute("aria-valuemin", "24");
    expect(el).toHaveAttribute("aria-valuemax", "76");
    expect(el).toHaveAccessibleName("Resize panes");
    expect(el).toHaveAttribute("data-split", "s1");
  });

  it("stands on the line the model left between the panes", () => {
    const { el } = setup(row);
    expect(el.style.left).toBe("49.95%");
    expect(el.style.width).toBe("0.0999%");
    expect(el.style.height).toBe("calc(100% - 0px)");
  });

  it("a line between two rows is a horizontal separator moved by Up and Down", async () => {
    const { el, onratio } = setup(col);
    expect(el).toHaveAttribute("aria-orientation", "horizontal");
    await fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(last(onratio)).toBeCloseTo(0.5 + 24 / 599);
    await fireEvent.keyDown(el, { key: "ArrowUp" });
    expect(last(onratio)).toBeCloseTo(0.5 - 24 / 599);
    // The other axis' arrows are not its keys.
    onratio.mockClear();
    await fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(onratio).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys, to the limits with Home and End, to the middle with Enter", async () => {
    const { el, onratio } = setup({ ...row, ratio: 0.3 });
    await fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(last(onratio)).toBeCloseTo(0.324);
    await fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(last(onratio)).toBeCloseTo(0.276);
    await fireEvent.keyDown(el, { key: "Home" });
    expect(last(onratio)).toBe(0.24);
    await fireEvent.keyDown(el, { key: "End" });
    expect(last(onratio)).toBe(0.76);
    await fireEvent.keyDown(el, { key: "Enter" });
    expect(last(onratio)).toBe(0.5);
  });

  it("an arrow never pushes a pane under its minimum", async () => {
    const { el, onratio } = setup({ ...row, ratio: 0.25 });
    await fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(last(onratio)).toBe(0.24);
  });

  it("leaves every other key to the page, without swallowing it", async () => {
    const { el, onratio } = setup(row);
    const passed = await fireEvent.keyDown(el, { key: "a" });
    expect(onratio).not.toHaveBeenCalled();
    expect(passed).toBe(true);
    // A key it does handle is its own.
    expect(await fireEvent.keyDown(el, { key: "ArrowRight" })).toBe(false);
  });

  it("a double-click sets the halves equal", async () => {
    const { el, onratio } = setup({ ...row, ratio: 0.3 });
    await fireEvent.dblClick(el);
    expect(onratio).toHaveBeenCalledExactlyOnceWith(0.5);
  });

  it("follows the pointer from where the drag began, inside the limits", async () => {
    const { el, onratio } = setup(row);
    await fireEvent.pointerDown(el, { clientX: 500, clientY: 100, pointerId: 1 });
    await fireEvent.pointerMove(el, { clientX: 400, clientY: 300, pointerId: 1 });
    expect(last(onratio)).toBeCloseTo(0.4);
    // Far past the limit: the pane keeps its minimum…
    await fireEvent.pointerMove(el, { clientX: 20, clientY: 300, pointerId: 1 });
    expect(last(onratio)).toBe(0.24);
    // …and coming back the handle is where the pointer is, not behind it.
    await fireEvent.pointerMove(el, { clientX: 450, clientY: 300, pointerId: 1 });
    expect(last(onratio)).toBeCloseTo(0.45);
    await fireEvent.pointerUp(el, { clientX: 450, clientY: 300, pointerId: 1 });
    onratio.mockClear();
    await fireEvent.pointerMove(el, { clientX: 300, clientY: 300, pointerId: 1 });
    expect(onratio).not.toHaveBeenCalled();
  });

  it("a column split follows the pointer's vertical travel", async () => {
    const { el, onratio } = setup(col);
    await fireEvent.pointerDown(el, { clientX: 100, clientY: 300, pointerId: 1 });
    await fireEvent.pointerMove(el, { clientX: 900, clientY: 360, pointerId: 1 });
    expect(last(onratio)).toBeCloseTo(0.5 + 60 / 599);
  });

  it("keeps the resize cursor over the whole window while dragging, with a z-index", async () => {
    const { el } = setup(row);
    expect(document.querySelector(".fixed.inset-0")).toBeNull();
    await fireEvent.pointerDown(el, { clientX: 500, clientY: 100, pointerId: 1 });
    const shield = document.querySelector(".fixed.inset-0");
    expect(shield).toHaveClass("z-50", "cursor-col-resize", "select-none");
    await fireEvent.pointerUp(el, { clientX: 500, clientY: 100, pointerId: 1 });
    expect(document.querySelector(".fixed.inset-0")).toBeNull();
  });
});
