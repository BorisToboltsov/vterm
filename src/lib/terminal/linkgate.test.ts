import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLinkGate,
  DEFAULT_LINK_CLICK,
  DOUBLE_CLICK_MS,
  hintPlace,
  HINT_LEAVE_PX,
  isLinkClick,
  linkGesture,
  migrateLinkSettings,
  pointerLeft,
  type LinkClick,
  type LinkHintKind,
  type LinkSettings,
} from "./linkgate";

const keys = (k: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...k,
});

describe("the click setting", () => {
  it("knows its values, ⌘-click by default", () => {
    expect(isLinkClick("modifier")).toBe(true);
    expect(isLinkClick("click")).toBe(true);
    expect(isLinkClick("ctrl")).toBe(false);
    expect(isLinkClick(undefined)).toBe(false);
    expect(DEFAULT_LINK_CLICK).toBe("modifier");
  });
});

describe("linkGesture", () => {
  it("in modifier mode opens on ⌘-click on macOS and shows the hint on a plain click", () => {
    expect(linkGesture("modifier", keys({ metaKey: true }), true)).toBe("open");
    expect(linkGesture("modifier", keys(), true)).toBe("hint");
  });

  it("in modifier mode opens on Ctrl-click off macOS; the Windows key is no modifier", () => {
    expect(linkGesture("modifier", keys({ ctrlKey: true }), false)).toBe("open");
    expect(linkGesture("modifier", keys({ metaKey: true }), false)).toBe("hint");
  });

  it("takes Ctrl-click on macOS for the secondary click, not for a click on the link", () => {
    expect(linkGesture("modifier", keys({ ctrlKey: true }), true)).toBe("none");
    expect(linkGesture("click", keys({ ctrlKey: true }), true)).toBe("none");
  });

  it("in click mode opens a plain click once a double-click is ruled out, a ⌘-click at once", () => {
    expect(linkGesture("click", keys(), true)).toBe("later");
    expect(linkGesture("click", keys({ metaKey: true }), true)).toBe("open");
    expect(linkGesture("click", keys({ ctrlKey: true }), false)).toBe("open");
  });

  it("leaves alt-click to xterm's cursor move and shift-click to the selection", () => {
    for (const click of ["modifier", "click"] as LinkClick[]) {
      for (const mac of [true, false]) {
        expect(linkGesture(click, keys({ altKey: true }), mac)).toBe("none");
        expect(linkGesture(click, keys({ shiftKey: true, metaKey: true, ctrlKey: true }), mac)).toBe("none");
      }
    }
  });
});

describe("createLinkGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(click: LinkClick = "modifier", mac = true) {
    let selected = false;
    const opened: string[] = [];
    const hints: { x: number; y: number; kind: LinkHintKind }[] = [];
    let act: (() => void) | undefined;
    const gate = createLinkGate({
      click: () => click,
      mac: () => mac,
      selected: () => selected,
      hint: (at, kind, a) => {
        hints.push({ ...at, kind });
        act = a;
      },
    });
    const click1 = (k: Partial<MouseEventInit> = {}, kind: LinkHintKind = "file") =>
      gate.activate(new MouseEvent("click", { clientX: 40, clientY: 60, detail: 1, ...k }), kind, () =>
        opened.push(kind),
      );
    return {
      gate,
      opened,
      hints,
      click: click1,
      select: (v: boolean) => (selected = v),
      follow: () => act?.(),
    };
  }

  it("opens a ⌘-click at once, with no hint", () => {
    const g = setup();
    g.click({ metaKey: true }, "web");
    expect(g.opened).toEqual(["web"]);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(g.hints).toEqual([]);
  });

  it("shows the hint for a plain click only after a double-click is ruled out, and opens nothing", () => {
    const g = setup();
    g.click({}, "dir");
    vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1);
    expect(g.hints).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(g.hints).toEqual([{ x: 40, y: 60, kind: "dir" }]);
    expect(g.opened).toEqual([]);
    g.follow();
    expect(g.opened).toEqual(["dir"]);
  });

  it("shows no hint for a double-click: the second click selects the name", () => {
    const g = setup();
    g.click({ detail: 1 });
    g.click({ detail: 2 });
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(g.hints).toEqual([]);
    expect(g.opened).toEqual([]);
  });

  it("does nothing while the terminal holds a selection, made before the click or during the wait", () => {
    const g = setup();
    g.select(true);
    g.click({ metaKey: true });
    g.click();
    expect(g.opened).toEqual([]);
    g.select(false);
    g.click();
    g.select(true);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(g.hints).toEqual([]);
  });

  it("in click mode opens a plain click after the wait, never the first of a double-click", () => {
    const g = setup("click");
    g.click();
    expect(g.opened).toEqual([]);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(g.opened).toEqual(["file"]);
    g.click({ detail: 1 });
    g.click({ detail: 2 });
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(g.opened).toEqual(["file"]);
    expect(g.hints).toEqual([]);
  });

  it("forgets a waiting click when it is disposed, or when another click comes", () => {
    const g = setup();
    g.click({}, "file");
    g.gate.dispose();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(g.hints).toEqual([]);
    g.click({}, "file");
    g.click({ metaKey: true }, "web");
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(g.hints).toEqual([]);
    expect(g.opened).toEqual(["web"]);
  });

  it("ignores alt-click altogether", () => {
    const g = setup();
    g.click({ altKey: true });
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(g.hints).toEqual([]);
    expect(g.opened).toEqual([]);
  });
});

describe("hintPlace", () => {
  const view = { w: 800, h: 600 };
  const size = { w: 180, h: 26 };

  it("stands just under the click, a little to its left", () => {
    expect(hintPlace({ x: 300, y: 200 }, size, view)).toEqual({ x: 290, y: 214 });
  });

  it("stays inside the window at its edges", () => {
    expect(hintPlace({ x: 790, y: 200 }, size, view).x).toBe(800 - 180 - 8);
    expect(hintPlace({ x: 2, y: 200 }, size, view).x).toBe(8);
  });

  it("goes above the click when the window ends below it", () => {
    expect(hintPlace({ x: 300, y: 580 }, size, view)).toEqual({ x: 290, y: 580 - 14 - 26 });
    expect(hintPlace({ x: 300, y: 20 }, size, { w: 800, h: 40 }).y).toBe(8);
  });
});

describe("pointerLeft", () => {
  it("lets the hint stay while the pointer is near the click", () => {
    expect(pointerLeft({ x: 100, y: 100 }, { x: 100 + HINT_LEAVE_PX, y: 100 })).toBe(false);
    expect(pointerLeft({ x: 100, y: 100 }, { x: 100 + HINT_LEAVE_PX, y: 101 })).toBe(true);
  });
});

describe("migrateLinkSettings", () => {
  const defaults: LinkSettings = { terminalLinks: "direct", terminalFileLinks: "direct", terminalLinkClick: "modifier" };

  it("turns the old default «ask first» into «open right away» for settings saved before the gate", () => {
    expect(
      migrateLinkSettings({ terminalLinks: "confirm", terminalFileLinks: "confirm", terminalFileLinkClick: "click" }, defaults),
    ).toEqual({ terminalLinks: "direct", terminalFileLinks: "direct", terminalLinkClick: "modifier" });
  });

  it("keeps «off» and «open right away» from before the gate", () => {
    expect(migrateLinkSettings({ terminalLinks: "off", terminalFileLinks: "direct" }, defaults)).toEqual({
      terminalLinks: "off",
      terminalFileLinks: "direct",
      terminalLinkClick: "modifier",
    });
  });

  it("takes «ask first» as a choice once the gate's setting is saved", () => {
    expect(
      migrateLinkSettings({ terminalLinks: "confirm", terminalFileLinks: "confirm", terminalLinkClick: "click" }, defaults),
    ).toEqual({ terminalLinks: "confirm", terminalFileLinks: "confirm", terminalLinkClick: "click" });
  });

  it("falls back to the defaults for junk", () => {
    expect(migrateLinkSettings({ terminalLinks: "maybe", terminalFileLinks: 3, terminalLinkClick: "ctrl" }, defaults)).toEqual(
      defaults,
    );
    expect(migrateLinkSettings({}, defaults)).toEqual(defaults);
  });
});
