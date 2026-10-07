import { describe, expect, it } from "vitest";
import { MAIN_WINDOW, isMainLabel, isMainWindow, readWindowLabel, windowLabel } from "./appwindow";

describe("which window this is", () => {
  it("only the label `main` is the main window", () => {
    expect(isMainLabel(MAIN_WINDOW)).toBe(true);
    expect(isMainLabel("win-2")).toBe(false);
    expect(isMainLabel("")).toBe(false);
  });

  it("reads the label of the window the page runs in", () => {
    expect(readWindowLabel(() => "win-3")).toBe("win-3");
  });

  it("outside a Tauri window the page is the main window", () => {
    // No runtime to ask (unit tests, the browser preview): reading throws.
    expect(
      readWindowLabel(() => {
        throw new TypeError("__TAURI_INTERNALS__ is undefined");
      }),
    ).toBe(MAIN_WINDOW);
    // A label that is not one is not trusted either.
    expect(readWindowLabel(() => "")).toBe(MAIN_WINDOW);
    expect(readWindowLabel(() => undefined as unknown as string)).toBe(MAIN_WINDOW);
  });

  it("under test this page is the main window", () => {
    expect(windowLabel).toBe(MAIN_WINDOW);
    expect(isMainWindow).toBe(true);
  });
});
