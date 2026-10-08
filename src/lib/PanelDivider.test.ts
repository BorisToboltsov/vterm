import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PanelDivider from "./PanelDivider.svelte";
import { PANEL_SPLITS } from "./panelsplit";
import { panelSplits, resetPanelShares, setPanelShare } from "./stores/panelsplit.svelte";

function setup(split: "git" | "docker" | "k8s" = "docker", width = 1000) {
  render(PanelDivider, { props: { split, width } });
  const el = screen.getByTestId("panel-divider");
  // jsdom implements neither; the resize action captures the pointer on press.
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  return el;
}

const drag = async (el: HTMLElement, from: number, to: number) => {
  await fireEvent.pointerDown(el, { pointerId: 1, clientX: from, clientY: 10 });
  await fireEvent.pointerMove(el, { pointerId: 1, clientX: to, clientY: 10 });
  await fireEvent.pointerUp(el, { pointerId: 1, clientX: to, clientY: 10 });
};

beforeEach(() => {
  localStorage.clear();
  resetPanelShares();
  flushSync();
});

describe("PanelDivider", () => {
  it("is a separator that says where it stands and how far it goes", () => {
    const el = setup("docker", 1000);
    expect(el).toHaveAttribute("role", "separator");
    expect(el).toHaveAttribute("aria-orientation", "vertical");
    expect(el).toHaveAttribute("aria-valuenow", "50");
    expect(el).toHaveAttribute("aria-valuemin", "24");
    expect(el).toHaveAttribute("aria-valuemax", "76");
    expect(el).toHaveAttribute("tabindex", "0");
  });

  it("a drag moves the border by as much as the pointer moved", async () => {
    const el = setup("docker", 1000);
    await drag(el, 500, 350);
    expect(panelSplits.shares.docker).toBeCloseTo(0.35);
    // The next drag starts from where the border is now.
    await drag(el, 350, 450);
    expect(panelSplits.shares.docker).toBeCloseTo(0.45);
  });

  it("stops where a part would go under its minimum, and does not drift from the pointer", async () => {
    const el = setup("docker", 1000);
    await fireEvent.pointerDown(el, { pointerId: 1, clientX: 500, clientY: 10 });
    await fireEvent.pointerMove(el, { pointerId: 1, clientX: 20, clientY: 10 });
    expect(panelSplits.shares.docker).toBeCloseTo(0.24);
    // Back past the start: measured from where the drag began, not from the limit.
    await fireEvent.pointerMove(el, { pointerId: 1, clientX: 600, clientY: 10 });
    expect(panelSplits.shares.docker).toBeCloseTo(0.6);
    await fireEvent.pointerUp(el, { pointerId: 1, clientX: 600, clientY: 10 });
  });

  it("holds the accent while it is dragged, and brings no overlay with it", async () => {
    const el = setup();
    const strip = el.querySelector("span")!;
    expect(strip).toHaveClass("bg-transparent");
    await fireEvent.pointerDown(el, { pointerId: 1, clientX: 500, clientY: 10 });
    expect(strip).toHaveClass("bg-accent");
    // It stands inside a panel's query container: nothing `fixed` may come with it.
    expect(document.querySelector(".fixed")).toBeNull();
    await fireEvent.pointerUp(el, { pointerId: 1, clientX: 500, clientY: 10 });
    expect(strip).toHaveClass("bg-transparent");
  });

  it("the arrow keys move it, Home and End go to the limits", async () => {
    const el = setup("k8s", 1000);
    await fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(panelSplits.shares.k8s).toBeCloseTo(0.476);
    await fireEvent.keyDown(el, { key: "ArrowRight" });
    await fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(panelSplits.shares.k8s).toBeCloseTo(0.524);
    await fireEvent.keyDown(el, { key: "Home" });
    expect(panelSplits.shares.k8s).toBeCloseTo(0.24);
    await fireEvent.keyDown(el, { key: "End" });
    expect(panelSplits.shares.k8s).toBeCloseTo(0.76);
    // Any other key is not its business.
    await fireEvent.keyDown(el, { key: "a" });
    expect(panelSplits.shares.k8s).toBeCloseTo(0.76);
  });

  it("Enter and a double click put it back where the panel starts", async () => {
    const el = setup("git", 1000);
    setPanelShare("git", 0.7);
    await fireEvent.keyDown(el, { key: "Enter" });
    expect(panelSplits.shares.git).toBeUndefined();
    setPanelShare("git", 0.7);
    await fireEvent.dblClick(el);
    expect(panelSplits.shares.git).toBeUndefined();
    flushSync();
    expect(el).toHaveAttribute("aria-valuenow", String(Math.round(PANEL_SPLITS.git * 100)));
  });
});
