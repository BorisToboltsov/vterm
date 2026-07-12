import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ThemeOverlay from "./ThemeOverlay.svelte";
import { resetSettings, settings } from "./settings.svelte";
import { getTheme } from "./themes";

afterEach(() => {
  resetSettings();
  flushSync();
});

describe("ThemeOverlay", () => {
  it("renders a full-window, click-through depth layer for a signature theme", () => {
    settings.theme = "deep-well";
    flushSync();
    render(ThemeOverlay, {});
    const el = screen.getByTestId("theme-overlay");
    // jsdom normalises inline styles with spaces after ':'.
    const style = (el.getAttribute("style") ?? "").replace(/\s+/g, "");
    expect(style).toContain("position:fixed");
    expect(style).toContain("pointer-events:none");
    // Paints the theme's window overlay gradient.
    expect(getTheme("deep-well").overlay).toBeTruthy();
    expect(style).toContain("gradient");
  });

  it("renders nothing for a classic theme (no overlay)", () => {
    settings.theme = "dracula";
    flushSync();
    render(ThemeOverlay, {});
    expect(screen.queryByTestId("theme-overlay")).toBeNull();
  });

  it("renders nothing for the custom theme", () => {
    settings.theme = "custom";
    flushSync();
    render(ThemeOverlay, {});
    expect(screen.queryByTestId("theme-overlay")).toBeNull();
  });
});
