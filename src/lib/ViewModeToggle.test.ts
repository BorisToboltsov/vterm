import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ViewModeToggle from "./ViewModeToggle.svelte";

describe("ViewModeToggle", () => {
  it("marks Raw as pressed when not structured", () => {
    render(ViewModeToggle, { props: { structured: false, onSelect: () => {} } });
    expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "false");
  });

  it("marks Table as pressed when structured", () => {
    render(ViewModeToggle, { props: { structured: true, onSelect: () => {} } });
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onSelect with the chosen mode", async () => {
    const onSelect = vi.fn();
    render(ViewModeToggle, { props: { structured: false, onSelect } });
    await fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(onSelect).toHaveBeenCalledWith(true);
    await fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(onSelect).toHaveBeenCalledWith(false);
  });

  it("collapses the labels via a container query when compact", () => {
    render(ViewModeToggle, { props: { structured: false, compact: true, onSelect: () => {} } });
    expect(screen.getByText("Raw")).toHaveClass("@max-[460px]:hidden");
    expect(screen.getByText("Table")).toHaveClass("@max-[460px]:hidden");
  });

  it("keeps the labels always visible when not compact", () => {
    render(ViewModeToggle, { props: { structured: false, onSelect: () => {} } });
    expect(screen.getByText("Raw")).not.toHaveClass("@max-[460px]:hidden");
  });

  it("is the log-view switch unless the caller describes other sides", () => {
    render(ViewModeToggle, { props: { structured: false, onSelect: () => {} } });
    expect(screen.getByRole("group", { name: "View mode" })).toHaveAttribute("data-testid", "view-mode-toggle");
  });

  it("takes its two sides, name and test id from the caller", async () => {
    // The k8s route and the Docker graph reuse the switch with their own words.
    const onSelect = vi.fn();
    render(ViewModeToggle, {
      props: {
        structured: true,
        onSelect,
        label: "Network view",
        off: { icon: "table", label: "List", tooltip: "As lists" },
        on: { icon: "gateway", label: "Route", tooltip: "As a route" },
        testid: "k8s-net-view",
      },
    });
    expect(screen.getByRole("group", { name: "Network view" })).toHaveAttribute("data-testid", "k8s-net-view");
    expect(screen.getByRole("button", { name: "Route" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(onSelect).toHaveBeenCalledWith(false);
  });
});
