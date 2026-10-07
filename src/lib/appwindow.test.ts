import { describe, expect, it } from "vitest";
import {
  MAIN_WINDOW,
  isMainLabel,
  isMainWindow,
  otherWindows,
  readWindowLabel,
  windowLabel,
  windowNumber,
  windowTarget,
} from "./appwindow";
import { messages } from "./i18n/messages";

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

describe("the other windows", () => {
  const roster = [
    { label: "main", title: "local", tabs: 4 },
    { label: "win-2", title: "web-01", tabs: 1 },
    { label: "win-3", title: "db", tabs: 3 },
  ];

  it("are every listed window but this one, in the order listed", () => {
    expect(otherWindows(roster, "win-2").map((w) => w.label)).toEqual(["main", "win-3"]);
    expect(otherWindows(roster, "main").map((w) => w.label)).toEqual(["win-2", "win-3"]);
    // The only window has nowhere to move a tab to.
    expect(otherWindows([roster[0]], "main")).toEqual([]);
  });

  it("what is not a list of windows gives none", () => {
    for (const junk of [null, undefined, "main", 3, { label: "main" }]) {
      expect(otherWindows(junk, "win-2")).toEqual([]);
    }
  });

  it("an entry that is not one is dropped, not shown as a nameless window", () => {
    const mixed = [
      null,
      "win-2",
      { label: "", title: "x", tabs: 1 },
      { label: "win-4", title: 7, tabs: 1 },
      { label: "win-5", title: "x", tabs: -1 },
      { label: "win-6", title: "x", tabs: 1.5 },
      { label: "win-7", title: "x" },
      { label: "win-8", title: "ok", tabs: 2, extra: "ignored" },
    ];
    expect(otherWindows(mixed, "main")).toEqual([{ label: "win-8", title: "ok", tabs: 2 }]);
  });

  it("a secondary window has a number, the main one and strangers do not", () => {
    expect(windowNumber("win-12")).toBe(12);
    expect(windowNumber("main")).toBeNull();
    expect(windowNumber("win-")).toBeNull();
    expect(windowNumber("win-2x")).toBeNull();
  });

  it("the main window is named as such, whatever it shows", () => {
    expect(windowTarget(roster[0])).toEqual({ key: "window.toMain" });
  });

  it("any other is told apart by the tab it shows, and how many more it holds", () => {
    expect(windowTarget(roster[1])).toEqual({ key: "window.toNamed", params: { name: "web-01" } });
    expect(windowTarget(roster[2])).toEqual({
      key: "window.toNamedMore",
      params: { name: "db", more: 2 },
    });
  });

  it("a window showing no tab falls back to its number", () => {
    expect(windowTarget({ label: "win-4", title: "", tabs: 0 })).toEqual({
      key: "window.toNumbered",
      params: { n: 4 },
    });
    // A label that is not ours still gets a name rather than an empty row.
    expect(windowTarget({ label: "odd", title: "", tabs: 0 })).toEqual({
      key: "window.toNumbered",
      params: { n: "odd" },
    });
  });

  it("every name exists in every language, with its placeholders", () => {
    const names = {
      "window.toMain": [],
      "window.toNamed": ["{name}"],
      "window.toNamedMore": ["{name}", "{more}"],
      "window.toNumbered": ["{n}"],
    } as const;
    for (const dict of Object.values(messages)) {
      for (const [key, holes] of Object.entries(names)) {
        const text = dict[key as keyof typeof names];
        expect(text, key).toBeTruthy();
        for (const hole of holes) expect(text, key).toContain(hole);
      }
    }
  });
});
