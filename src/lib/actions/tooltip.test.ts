import { afterEach, describe, expect, it, vi } from "vitest";
import { tooltip } from "./tooltip";

// The action mounts the bubble on document.body; clean it up between cases.
afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll(".vt-tooltip").forEach((n) => n.remove());
  document.body.innerHTML = "";
});

function mount(text: string | undefined) {
  const node = document.createElement("button");
  document.body.appendChild(node);
  const handle = tooltip(node, text);
  return { node, handle };
}

const tip = () => document.querySelector<HTMLElement>(".vt-tooltip");

describe("tooltip action", () => {
  it("delays a hovered tooltip, then shows it (role=tooltip, portalled)", () => {
    vi.useFakeTimers();
    const { node } = mount("Explain this field");

    node.dispatchEvent(new MouseEvent("mouseenter"));
    expect(tip()).toBeNull(); // not immediate on hover

    vi.advanceTimersByTime(200);
    expect(tip()).toBeNull(); // still within the open-delay

    vi.advanceTimersByTime(400); // past ~500ms total
    const el = tip();
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute("role", "tooltip");
    expect(el).toHaveTextContent("Explain this field");
    expect(el!.parentElement).toBe(document.body);

    node.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tip()).toBeNull();
  });

  it("cancels the pending tooltip if the pointer leaves before the delay", () => {
    vi.useFakeTimers();
    const { node } = mount("gone before shown");
    node.dispatchEvent(new MouseEvent("mouseenter"));
    node.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(1000);
    expect(tip()).toBeNull();
  });

  it("shows instantly on keyboard focus (no delay) and hides on blur", () => {
    const { node } = mount("Keyboard reachable");
    node.dispatchEvent(new FocusEvent("focus"));
    expect(tip()).toHaveTextContent("Keyboard reachable"); // immediate
    node.dispatchEvent(new FocusEvent("blur"));
    expect(tip()).toBeNull();
  });

  it("skips the delay for a hover right after another tooltip closed", () => {
    vi.useFakeTimers();
    const a = mount("first");
    const b = mount("second");
    // Show + hide the first (focus is instant), which starts the skip window.
    a.node.dispatchEvent(new FocusEvent("focus"));
    a.node.dispatchEvent(new FocusEvent("blur"));
    // Hovering the second within the skip window shows it immediately.
    vi.advanceTimersByTime(100);
    b.node.dispatchEvent(new MouseEvent("mouseenter"));
    expect(tip()).toHaveTextContent("second");
  });

  it("does nothing when there is no text", () => {
    const { node } = mount(undefined);
    node.dispatchEvent(new FocusEvent("focus"));
    expect(tip()).toBeNull();
  });

  it("update() re-labels an open bubble", () => {
    const { node, handle } = mount("old");
    node.dispatchEvent(new FocusEvent("focus"));
    expect(tip()).toHaveTextContent("old");
    handle.update?.("new");
    expect(tip()).toHaveTextContent("new");
  });

  it("destroy() removes the bubble and stops responding", () => {
    const { node, handle } = mount("gone");
    node.dispatchEvent(new FocusEvent("focus"));
    expect(tip()).not.toBeNull();
    handle.destroy?.();
    expect(tip()).toBeNull();
    node.dispatchEvent(new FocusEvent("focus"));
    expect(tip()).toBeNull();
  });
});
