import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import AppearanceSettings from "./AppearanceSettings.svelte";
import { resetSettings, settings } from "../settings/settings.svelte";

afterEach(() => {
  resetSettings();
  flushSync();
});

const range = () => screen.getByTestId("ui-scale-range") as HTMLInputElement;
const value = () => screen.getByTestId("ui-scale-value").textContent?.trim();

describe("interface scale control", () => {
  it("shows the current stop", () => {
    settings.uiScale = 125;
    render(AppearanceSettings);
    expect(range().value).toBe("3");
    expect(value()).toBe("125%");
  });

  it("takes the scale when the thumb is let go, not while it moves", async () => {
    render(AppearanceSettings);
    range().value = "4";
    await fireEvent.input(range());
    // The number follows; the interface does not, or the slider runs from the pointer.
    expect(value()).toBe("150%");
    expect(settings.uiScale).toBe(100);
    await fireEvent.change(range());
    expect(settings.uiScale).toBe(150);
    expect(value()).toBe("150%");
  });

  it("offers every stop as a click under the track", async () => {
    render(AppearanceSettings);
    const stops = screen.getAllByTestId("ui-scale-stop");
    expect(stops.map((s) => s.textContent?.trim())).toEqual(["90", "100", "110", "125", "150"]);
    await fireEvent.click(stops[0]);
    expect(settings.uiScale).toBe(90);
    expect(stops[0].className).toContain("text-accent");
  });

  it("resets to 100 %, and has nothing to reset at 100 %", async () => {
    settings.uiScale = 150;
    render(AppearanceSettings);
    const reset = screen.getByTestId("ui-scale-reset") as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    await fireEvent.click(reset);
    expect(settings.uiScale).toBe(100);
    expect(reset.disabled).toBe(true);
  });
});

describe("terminal font on screen", () => {
  it("says nothing at 100 %, where the field is what is on screen", () => {
    render(AppearanceSettings);
    expect(screen.queryByTestId("font-size-on-screen")).toBeNull();
  });

  it("says what the size in the field comes to at another scale", () => {
    settings.uiScale = 125;
    render(AppearanceSettings);
    expect(screen.getByTestId("font-size-on-screen").textContent).toContain("16 px (13 × 125%)");
    expect(screen.getByRole("spinbutton", { name: /Terminal font size/ })).toHaveValue(13);
  });
});
