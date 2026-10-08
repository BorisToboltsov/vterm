import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it, vi } from "vitest";
import SidePane from "./SidePane.svelte";

const body = createRawSnippet(() => ({ render: () => `<pre data-testid="body">logs</pre>` }));

describe("SidePane", () => {
  it("is a named region beside the list, not a dialog", () => {
    render(SidePane, { props: { title: "edge-proxy", testid: "side", children: body } });
    const pane = screen.getByTestId("side");
    expect(pane.tagName).toBe("SECTION");
    expect(pane).toHaveAttribute("aria-label", "edge-proxy");
    expect(pane).not.toHaveAttribute("aria-modal");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pane).toContainElement(screen.getByTestId("body"));
    expect(screen.getByText("edge-proxy")).toBeInTheDocument();
  });

  it("takes the room it is given and lets its content fill it", () => {
    render(SidePane, { props: { title: "t", testid: "side", children: body } });
    const pane = screen.getByTestId("side");
    expect(pane).toHaveClass("flex", "h-full", "min-h-0", "min-w-0", "flex-col");
    // The line between it and the list is the panel's divider, not a border of its own.
    expect(pane).not.toHaveClass("border-l");
    expect(screen.getByTestId("body").parentElement).toHaveClass("flex", "min-h-0", "flex-1", "flex-col");
  });

  it("closes by its button, which says what it does", async () => {
    const onclose = vi.fn();
    render(SidePane, { props: { title: "t", onclose, children: body } });
    const close = screen.getByRole("button", { name: "Close" });
    await fireEvent.click(close);
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("has no close button when it cannot be closed", () => {
    render(SidePane, { props: { title: "t", children: body } });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
