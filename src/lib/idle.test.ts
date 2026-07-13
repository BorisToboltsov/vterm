import { describe, it, expect } from "vitest";
import {
  clampIdleTimeout,
  DEFAULT_IDLE_TIMEOUT,
  IDLE_EFFECTS,
  IDLE_TIMEOUT_MAX,
  IDLE_TIMEOUT_MIN,
  isIdle,
  isIdleSetting,
  msUntilIdle,
  swallowDismiss,
} from "./idle";

describe("isIdleSetting", () => {
  it("accepts off and every known effect", () => {
    expect(isIdleSetting("off")).toBe(true);
    for (const e of IDLE_EFFECTS) expect(isIdleSetting(e)).toBe(true);
  });
  it("rejects junk", () => {
    expect(isIdleSetting("nope")).toBe(false);
    expect(isIdleSetting(3)).toBe(false);
    expect(isIdleSetting(undefined)).toBe(false);
  });
});

describe("clampIdleTimeout", () => {
  it("defaults to 5 minutes", () => {
    expect(DEFAULT_IDLE_TIMEOUT).toBe(300);
  });
  it("keeps in-range whole seconds", () => {
    expect(clampIdleTimeout(180)).toBe(180);
    expect(clampIdleTimeout(20.6)).toBe(21);
  });
  it("clamps to the bounds", () => {
    expect(clampIdleTimeout(0)).toBe(IDLE_TIMEOUT_MIN);
    expect(clampIdleTimeout(99999)).toBe(IDLE_TIMEOUT_MAX);
  });
  it("falls back to the default for junk", () => {
    expect(clampIdleTimeout("x")).toBe(DEFAULT_IDLE_TIMEOUT);
    expect(clampIdleTimeout(NaN)).toBe(DEFAULT_IDLE_TIMEOUT);
    expect(clampIdleTimeout(undefined)).toBe(DEFAULT_IDLE_TIMEOUT);
  });
});

describe("swallowDismiss", () => {
  it("swallows only gestures on the screensaver canvas, lets dock/menu clicks through", () => {
    const canvas = document.createElement("canvas");
    const child = document.createElement("div");
    canvas.appendChild(child);
    const dockButton = document.createElement("button"); // e.g. a git menu item

    // On the canvas (or its descendants) → swallow (protects the terminal).
    expect(swallowDismiss(canvas, canvas)).toBe(true);
    expect(swallowDismiss(child, canvas)).toBe(true);
    // Elsewhere (the right dock / context menu) → let through so it still clicks.
    expect(swallowDismiss(dockButton, canvas)).toBe(false);
    // Degenerate inputs.
    expect(swallowDismiss(null, canvas)).toBe(false);
    expect(swallowDismiss(dockButton, null)).toBe(false);
    expect(swallowDismiss(dockButton, undefined)).toBe(false);
  });
});

describe("isIdle / msUntilIdle", () => {
  it("is idle once the timeout has fully elapsed", () => {
    expect(isIdle(0, 180_000, 180)).toBe(true);
    expect(isIdle(0, 179_999, 180)).toBe(false);
  });
  it("counts down to zero and never negative", () => {
    expect(msUntilIdle(0, 0, 180)).toBe(180_000);
    expect(msUntilIdle(0, 60_000, 180)).toBe(120_000);
    expect(msUntilIdle(0, 999_999, 180)).toBe(0);
  });
});
