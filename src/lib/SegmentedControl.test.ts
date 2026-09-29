import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import { tick } from "svelte";
import SegmentedControl from "./SegmentedControl.svelte";

const options = [
  { value: "password", label: "Password" },
  { value: "key", label: "SSH key" },
];

function setup(value = "password") {
  return render(SegmentedControl, { props: { value, options, label: "Authentication" } });
}

describe("SegmentedControl", () => {
  it("is a labelled radio group with one checked option and one tab stop", () => {
    setup();
    expect(screen.getByRole("radiogroup", { name: "Authentication" })).toBeInTheDocument();
    const pw = screen.getByRole("radio", { name: "Password" });
    const key = screen.getByRole("radio", { name: "SSH key" });
    expect(pw).toHaveAttribute("aria-checked", "true");
    expect(key).toHaveAttribute("aria-checked", "false");
    expect(pw).toHaveAttribute("tabindex", "0");
    expect(key).toHaveAttribute("tabindex", "-1");
  });

  it("selects on click", async () => {
    setup();
    await fireEvent.click(screen.getByRole("radio", { name: "SSH key" }));
    expect(screen.getByRole("radio", { name: "SSH key" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Password" })).toHaveAttribute("tabindex", "-1");
  });

  it("arrow keys move the choice and the focus, wrapping", async () => {
    setup();
    const pw = screen.getByRole("radio", { name: "Password" });
    pw.focus();
    await fireEvent.keyDown(pw, { key: "ArrowRight" });
    await tick();
    const key = screen.getByRole("radio", { name: "SSH key" });
    expect(key).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(key);
    await fireEvent.keyDown(key, { key: "ArrowRight" });
    await tick();
    expect(pw).toHaveAttribute("aria-checked", "true");
  });

  it("leaves non-navigation keys alone", async () => {
    setup();
    const pw = screen.getByRole("radio", { name: "Password" });
    await fireEvent.keyDown(pw, { key: "x" });
    expect(pw).toHaveAttribute("aria-checked", "true");
  });
});
