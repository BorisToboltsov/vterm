import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import ServerIconPicker from "./ServerIconPicker.svelte";

const base = { label: "Icon" };

describe("ServerIconPicker", () => {
  it("is collapsed by default: shows the selection preview, hides the grid", () => {
    render(ServerIconPicker, { props: { ...base, icon: "database", color: "green" } });
    // The chosen glyph stays visible in the disclosure header even when folded.
    expect(screen.getByTestId("server-icon-preview")).toBeInTheDocument();
    // The grid/swatches are not rendered until expanded.
    expect(screen.queryByTestId("server-icon-generic")).toBeNull();
    expect(screen.queryByTestId("server-color-none")).toBeNull();
  });

  it("expands to reveal the full glyph grid and colour swatches", async () => {
    render(ServerIconPicker, { props: { ...base, icon: "", color: "" } });
    await fireEvent.click(screen.getByTestId("server-icon-section"));
    expect(screen.getByTestId("server-icon-generic")).toBeInTheDocument();
    expect(screen.getByTestId("server-icon-kubernetes")).toBeInTheDocument();
    expect(screen.getByTestId("server-color-none")).toBeInTheDocument();
    expect(screen.getByTestId("server-color-green")).toBeInTheDocument();
  });

  it("marks the selected glyph and colour via aria-pressed", () => {
    render(ServerIconPicker, { props: { ...base, icon: "database", color: "green", open: true } });
    expect(screen.getByTestId("server-icon-database")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("server-icon-web")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("server-color-green")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("server-color-none")).toHaveAttribute("aria-pressed", "false");
  });

  it("updates the pressed glyph when a different one is clicked", async () => {
    render(ServerIconPicker, { props: { ...base, icon: "", color: "", open: true } });
    const web = screen.getByTestId("server-icon-web");
    expect(web).toHaveAttribute("aria-pressed", "false");
    await fireEvent.click(web);
    expect(web).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("server-icon-generic")).toHaveAttribute("aria-pressed", "false");
  });

  it("updates the pressed colour when a swatch is clicked", async () => {
    render(ServerIconPicker, { props: { ...base, icon: "", color: "", open: true } });
    const red = screen.getByTestId("server-color-red");
    await fireEvent.click(red);
    expect(red).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("server-color-none")).toHaveAttribute("aria-pressed", "false");
  });
});
