import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import ServerIconPicker from "./ServerIconPicker.svelte";

const base = { label: "Icon" };

describe("ServerIconPicker", () => {
  it("shows the full glyph grid and colour swatches without a fold", () => {
    render(ServerIconPicker, { props: { ...base, icon: "", color: "" } });
    // No inner disclosure: the picker already lives in a collapsible form section.
    expect(screen.queryByTestId("server-icon-section")).toBeNull();
    expect(screen.getByTestId("server-icon-generic")).toBeInTheDocument();
    expect(screen.getByTestId("server-icon-kubernetes")).toBeInTheDocument();
    expect(screen.getByTestId("server-color-none")).toBeInTheDocument();
    expect(screen.getByTestId("server-color-green")).toBeInTheDocument();
  });

  it("marks the selected glyph and colour via aria-pressed", () => {
    render(ServerIconPicker, { props: { ...base, icon: "database", color: "green" } });
    expect(screen.getByTestId("server-icon-database")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("server-icon-web")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("server-color-green")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("server-color-none")).toHaveAttribute("aria-pressed", "false");
  });

  it("updates the pressed glyph when a different one is clicked", async () => {
    render(ServerIconPicker, { props: { ...base, icon: "", color: "" } });
    const web = screen.getByTestId("server-icon-web");
    expect(web).toHaveAttribute("aria-pressed", "false");
    await fireEvent.click(web);
    expect(web).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("server-icon-generic")).toHaveAttribute("aria-pressed", "false");
  });

  it("updates the pressed colour when a swatch is clicked", async () => {
    render(ServerIconPicker, { props: { ...base, icon: "", color: "" } });
    const red = screen.getByTestId("server-color-red");
    await fireEvent.click(red);
    expect(red).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("server-color-none")).toHaveAttribute("aria-pressed", "false");
  });
});
