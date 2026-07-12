import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import AppLogo from "./AppLogo.svelte";
import { resetSettings, settings } from "./settings.svelte";
import { getTheme } from "./themes";

afterEach(() => {
  resetSettings();
  flushSync();
});

describe("AppLogo", () => {
  it("renders the logo with an accessible label", () => {
    render(AppLogo, { props: { label: "vterm" } });
    const el = screen.getByTestId("app-logo");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("aria-label", "vterm");
  });

  it("paints the active signature theme's backdrop as the square", () => {
    settings.theme = "deep-well";
    flushSync();
    render(AppLogo, {});
    const el = screen.getByTestId("app-logo");
    // The signature backdrop gradient is used as the icon background in-app.
    expect(el.getAttribute("style")).toContain("radial-gradient");
    expect(getTheme("deep-well").backdrop).toBeTruthy();
  });

  it("falls back to the flat panel token for a classic theme", () => {
    settings.theme = "dracula";
    flushSync();
    render(AppLogo, {});
    const el = screen.getByTestId("app-logo");
    // No backdrop → the square uses the themed panel colour, mark uses the accent.
    expect(el.getAttribute("style")).toContain("var(--color-panel)");
    expect(el.getAttribute("style")).not.toContain("gradient");
  });
});
