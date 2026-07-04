import { afterEach, describe, expect, it } from "vitest";
import { tooltip } from "./tooltip";

// The action mounts the bubble on document.body; clean it up between cases.
afterEach(() => {
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
  it("shows a role=tooltip bubble on hover and removes it on leave", () => {
    const { node } = mount("Explain this field");
    expect(tip()).toBeNull();

    node.dispatchEvent(new MouseEvent("mouseenter"));
    const el = tip();
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute("role", "tooltip");
    expect(el).toHaveTextContent("Explain this field");
    // It's portalled to <body>, not left inside the trigger.
    expect(el!.parentElement).toBe(document.body);

    node.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tip()).toBeNull();
  });

  it("also shows on keyboard focus and hides on blur", () => {
    const { node } = mount("Keyboard reachable");
    node.dispatchEvent(new FocusEvent("focus"));
    expect(tip()).toHaveTextContent("Keyboard reachable");
    node.dispatchEvent(new FocusEvent("blur"));
    expect(tip()).toBeNull();
  });

  it("does nothing when there is no text", () => {
    const { node } = mount(undefined);
    node.dispatchEvent(new MouseEvent("mouseenter"));
    expect(tip()).toBeNull();
  });

  it("update() re-labels an open bubble", () => {
    const { node, handle } = mount("old");
    node.dispatchEvent(new MouseEvent("mouseenter"));
    expect(tip()).toHaveTextContent("old");
    handle.update?.("new");
    expect(tip()).toHaveTextContent("new");
  });

  it("destroy() removes the bubble and stops responding", () => {
    const { node, handle } = mount("gone");
    node.dispatchEvent(new MouseEvent("mouseenter"));
    expect(tip()).not.toBeNull();
    handle.destroy?.();
    expect(tip()).toBeNull();
    // Listeners are gone: hovering again does nothing.
    node.dispatchEvent(new MouseEvent("mouseenter"));
    expect(tip()).toBeNull();
  });
});
