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
});
