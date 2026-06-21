import { describe, expect, it, vi } from "vitest";
import { dropTargetAt, passedThreshold, resizableHandle } from "./drag";

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

    node.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, pointerId: 1 }));
    expect(onStart).toHaveBeenCalledOnce();
    node.dispatchEvent(new PointerEvent("pointermove", { clientX: 130, pointerId: 1 }));
    expect(onResize).toHaveBeenCalledWith(30);
    node.dispatchEvent(new PointerEvent("pointerup", { clientX: 130, pointerId: 1 }));
    expect(onEnd).toHaveBeenCalledOnce();

    // After release, moves are ignored.
    onResize.mockClear();
    node.dispatchEvent(new PointerEvent("pointermove", { clientX: 200, pointerId: 1 }));
    expect(onResize).not.toHaveBeenCalled();

    handle.destroy();
  });
});
