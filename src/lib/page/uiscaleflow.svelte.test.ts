import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSettings, settings } from "../settings/settings.svelte";
import { clearToasts, toastsState } from "../stores/toasts.svelte";
import { createUiScaleFlow } from "./uiscaleflow.svelte";

beforeEach(() => clearToasts());
afterEach(() => {
  resetSettings();
  flushSync();
  clearToasts();
});

describe("interface scale, stepped from the page", () => {
  it("moves one stop and says where it landed", () => {
    createUiScaleFlow().step(1);
    expect(settings.uiScale).toBe(110);
    expect(toastsState.list.map((x) => x.message)).toEqual(["Interface scale: 110%"]);
  });

  it("keeps one word on screen, however fast the chord repeats", () => {
    const flow = createUiScaleFlow();
    flow.step(1);
    flow.step(1);
    flow.step(1);
    expect(settings.uiScale).toBe(150);
    expect(toastsState.list.map((x) => x.message)).toEqual(["Interface scale: 150%"]);
  });

  it("says so at the end of the scale, where nothing moves", () => {
    settings.uiScale = 150;
    createUiScaleFlow().step(1);
    expect(settings.uiScale).toBe(150);
    expect(toastsState.list.map((x) => x.message)).toEqual(["Interface scale: 150%"]);
  });

  it("goes back to 100 %", () => {
    settings.uiScale = 90;
    createUiScaleFlow().step(0);
    expect(settings.uiScale).toBe(100);
  });
});
