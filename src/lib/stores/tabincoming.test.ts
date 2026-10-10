import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panes } from "../splitlayout";
import {
  INCOMING_TAB,
  LANDING_TIMEOUT_MS,
  applyDragMessage,
  clearIncoming,
  describeTab,
  incoming,
  incomingAsTab,
  parseDragMessage,
  takeIncomingDrop,
  type IncomingTab,
} from "./tabincoming.svelte";
import { openLocalTab, resetTabs, splitTabOff, tabsState, type Tab } from "./tabs.svelte";

const web: IncomingTab = { kind: "ssh", serverId: "srv-1", alias: "web-01", status: "Connected" };

// jsdom has no layout: `elementFromPoint` is supplied per test, and an element's
// rectangle is whatever the test says it is.
function rect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () => r as DOMRect;
}
const byId = (id: string) => document.getElementById(id) as HTMLElement;
const at = (id: string | null) =>
  (document.elementFromPoint = () => (id === null ? null : document.getElementById(id)));

let left = "";
let right = "";

/** `[a b] | [c]` drawn the way the page marks it: a strip and a body per pane. */
beforeEach(() => {
  clearIncoming();
  resetTabs();
  openLocalTab();
  openLocalTab();
  const c = openLocalTab();
  left = tabsState.center.focus;
  splitTabOff(c, left, "right");
  right = tabsState.center.focus;
  const [a, b] = panes(tabsState.center)[0].tabs;
  document.body.innerHTML = `
    <div data-pane="${left}" id="paneL">
      <div data-tabstrip="${left}" id="stripL">
        <div data-tab="${a}" id="tabA"></div><div data-tab="${b}" id="tabB"></div>
      </div>
    </div>
    <div data-pane="${right}" id="paneR">
      <div data-tabstrip="${right}" id="stripR"><div data-tab="${c}" id="tabC"></div></div>
    </div>
    <div data-pane-body="${left}" id="bodyL"></div>
    <div data-pane-body="${right}" id="bodyR"></div>
    <div id="dock"></div>`;
  for (const [id, x] of [
    ["tabA", 0],
    ["tabB", 100],
    ["tabC", 600],
  ] as const) {
    rect(byId(id), { left: x, top: 0, width: 100, height: 30 });
  }
  rect(byId("paneL"), { left: 0, top: 0, width: 600, height: 430 });
  rect(byId("paneR"), { left: 600, top: 0, width: 600, height: 430 });
  rect(byId("bodyL"), { left: 0, top: 30, width: 600, height: 400 });
  rect(byId("bodyR"), { left: 600, top: 30, width: 600, height: 400 });
});

afterEach(() => {
  clearIncoming();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("parseDragMessage", () => {
  it("reads the three things a window is told", () => {
    expect(parseDragMessage({ kind: "over", x: 10, y: 20, tab: web })).toEqual({
      kind: "over",
      x: 10,
      y: 20,
      tab: web,
    });
    expect(parseDragMessage({ kind: "drop", x: 1.5, y: 0, tab: web })?.kind).toBe("drop");
    expect(parseDragMessage({ kind: "leave" })).toEqual({ kind: "leave" });
  });

  it("what is not one of them is dropped", () => {
    for (const junk of [null, undefined, "over", 3, [], {}, { kind: "enter" }]) {
      expect(parseDragMessage(junk)).toBeNull();
    }
  });

  it("a point that is not one draws nothing", () => {
    for (const bad of [
      { x: "10", y: 20 },
      { x: 10 },
      { x: Number.NaN, y: 0 },
      { x: 0, y: Number.POSITIVE_INFINITY },
    ]) {
      expect(parseDragMessage({ kind: "over", tab: web, ...bad })).toBeNull();
    }
  });

  it("a tab that could not be drawn is refused whole", () => {
    for (const tab of [
      null,
      "web-01",
      { ...web, kind: "serial" },
      { ...web, alias: 7 },
      { kind: "ssh", serverId: "srv-1", alias: "web-01" },
    ]) {
      expect(parseDragMessage({ kind: "over", x: 0, y: 0, tab })).toBeNull();
    }
  });

  it("keeps only what is drawn — nothing else a sender put in comes through", () => {
    const msg = parseDragMessage({
      kind: "over",
      x: 0,
      y: 0,
      tab: {
        ...web,
        secret: "hunter2",
        sessionId: "s1",
        attach: { kind: "container", name: "nginx", image: "nginx:1.27", argv: ["rm", "-rf"] },
      },
    });
    expect(msg).toEqual({
      kind: "over",
      x: 0,
      y: 0,
      tab: { ...web, attach: { kind: "container", name: "nginx", image: "nginx:1.27" } },
    });
  });

  it("an attachment that does not read as one is left out, the tab stays", () => {
    const msg = parseDragMessage({
      kind: "over",
      x: 0,
      y: 0,
      tab: { ...web, attach: { kind: "vm", name: "x" } },
    });
    expect(msg).toEqual({ kind: "over", x: 0, y: 0, tab: web });
  });
});

describe("describeTab", () => {
  const tab: Tab = {
    sessionId: "s1",
    kind: "ssh",
    serverId: "srv-1",
    alias: "web-01",
    secret: "hunter2",
    remember: true,
    status: "Connected",
    gen: 4,
  };

  it("sends what is drawn and nothing else — not the secret, not the session", () => {
    expect(describeTab(tab)).toEqual(web);
  });

  it("a container tab goes with its mark, without the argv that enters it", () => {
    const attached: Tab = {
      ...tab,
      attach: { kind: "pod", name: "api-7d9", container: "app", argv: ["kubectl", "exec"] },
    };
    expect(describeTab(attached)).toEqual({
      ...web,
      attach: { kind: "pod", name: "api-7d9", container: "app" },
    });
    // What one window describes, the other reads back.
    expect(parseDragMessage({ kind: "over", x: 0, y: 0, tab: describeTab(attached) })?.kind).toBe(
      "over",
    );
  });
});

describe("a tab of another window held over this one", () => {
  const over = (x: number, y: number) => applyDragMessage({ kind: "over", x, y, tab: web });
  const drop = (x: number, y: number) => applyDragMessage({ kind: "drop", x, y, tab: web });

  it("is drawn where the pointer is, and aimed at the slot it is over", () => {
    at("stripL");
    over(160, 10);
    expect(incoming.tab).toEqual(web);
    expect([incoming.x, incoming.y]).toEqual([160, 10]);
    // Past the middle of the second tab: after it.
    expect(incoming.over).toEqual({ kind: "strip", pane: left, index: 2 });
    expect(incoming.zone).toBeNull();
    over(40, 10);
    expect(incoming.over).toEqual({ kind: "strip", pane: left, index: 0 });
  });

  it("the same tab over the same place again is not written anew", () => {
    at("stripL");
    // Every message of a drag carries the tab, and the place is worked out afresh.
    applyDragMessage({ kind: "over", x: 160, y: 10, tab: { ...web } });
    const tab = incoming.tab;
    const target = incoming.over;
    applyDragMessage({ kind: "over", x: 163, y: 12, tab: { ...web } });
    // Written again, either would redraw the strip the tab is shown in — and a
    // redrawn strip starts its tabs' slides over.
    expect(incoming.tab).toBe(tab);
    expect(incoming.over).toBe(target);
    expect([incoming.x, incoming.y]).toEqual([163, 12]);
    // What changed is written: the tab's state, the slot.
    applyDragMessage({ kind: "over", x: 163, y: 12, tab: { ...web, status: "Disconnected" } });
    expect(incoming.tab).not.toBe(tab);
    expect(incoming.tab?.status).toBe("Disconnected");
    applyDragMessage({ kind: "over", x: 40, y: 10, tab: { ...web, status: "Disconnected" } });
    expect(incoming.over).toEqual({ kind: "strip", pane: left, index: 0 });
  });

  it("over a pane's body: its middle, or the half an edge would give it", () => {
    at("bodyR");
    over(900, 230);
    expect(incoming.over).toEqual({ kind: "pane", pane: right, zone: "center" });
    expect(incoming.zone).toEqual({ x: 600, y: 30, w: 600, h: 400 });
    over(1190, 230);
    expect(incoming.over).toEqual({ kind: "pane", pane: right, zone: "right" });
    expect(incoming.zone).toEqual({ x: 900, y: 30, w: 300, h: 400 });
  });

  it("over anything else it is still drawn — and goes where a new tab goes", () => {
    at("dock");
    over(300, 500);
    expect(incoming.tab).toEqual(web);
    expect(incoming.over).toBeNull();
    expect(incoming.zone).toBeNull();
  });

  it("changes nothing in the layout while it is held", () => {
    const before = tabsState.center;
    at("stripL");
    over(160, 10);
    at("bodyR");
    over(1190, 230);
    expect(tabsState.center).toBe(before);
  });

  it("gone elsewhere, it is forgotten", () => {
    at("stripL");
    over(160, 10);
    applyDragMessage({ kind: "leave" });
    expect(incoming.tab).toBeNull();
    expect(incoming.over).toBeNull();
    expect(takeIncomingDrop()).toBeNull();
  });

  it("let go of here, its place is kept until the tab arrives", () => {
    at("stripL");
    over(40, 10);
    drop(160, 10);
    expect(incoming.landing).toBe(true);
    // The place it was dropped at, not the one it was last held over.
    expect(incoming.over).toEqual({ kind: "strip", pane: left, index: 2 });
    // What is still on its way from the drag changes nothing.
    at("bodyR");
    over(900, 230);
    drop(900, 230);
    expect(incoming.over).toEqual({ kind: "strip", pane: left, index: 2 });
    // The tab arrives: it gets that place, and the preview ends.
    expect(takeIncomingDrop()).toEqual({ kind: "strip", pane: left, index: 2 });
    expect(incoming.tab).toBeNull();
    expect(incoming.landing).toBe(false);
    expect(takeIncomingDrop()).toBeNull();
  });

  it("a tab that arrives while another is only held here does not take its place", () => {
    at("stripL");
    over(160, 10);
    // Sent by a command from a third window: it goes where a new tab goes…
    expect(takeIncomingDrop()).toBeNull();
    // …and the held one is still drawn.
    expect(incoming.tab).toEqual(web);
  });

  it("a drop that came to nothing gives its place up", () => {
    at("stripL");
    drop(160, 10);
    applyDragMessage({ kind: "leave" });
    expect(incoming.landing).toBe(false);
    expect(incoming.tab).toBeNull();
    expect(takeIncomingDrop()).toBeNull();
  });

  it("a tab that never arrives does not hold its place for ever", () => {
    vi.useFakeTimers();
    at("stripL");
    drop(160, 10);
    vi.advanceTimersByTime(LANDING_TIMEOUT_MS - 1);
    expect(incoming.landing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(incoming.tab).toBeNull();
    expect(incoming.landing).toBe(false);
  });

  it("an earlier wait does not cut a later tab's short", () => {
    vi.useFakeTimers();
    at("stripL");
    drop(160, 10);
    vi.advanceTimersByTime(LANDING_TIMEOUT_MS - 1000);
    expect(takeIncomingDrop()).not.toBeNull();
    drop(40, 10);
    vi.advanceTimersByTime(2000);
    // The first drop's timer was cancelled with it.
    expect(incoming.landing).toBe(true);
  });
});

describe("incomingAsTab", () => {
  it("is nothing while no tab is held", () => {
    expect(incomingAsTab()).toBeNull();
  });

  it("is a tab like any other under an id no session has — and with nothing to run", () => {
    applyDragMessage({
      kind: "over",
      x: 0,
      y: 0,
      tab: { ...web, attach: { kind: "container", name: "nginx" } },
    });
    expect(incomingAsTab()).toEqual({
      ...web,
      sessionId: INCOMING_TAB,
      secret: null,
      remember: false,
      gen: 0,
      attach: { kind: "container", name: "nginx", argv: [] },
    });
    // The placeholder's id can never be a session's.
    expect(tabsState.list.some((t) => t.sessionId === INCOMING_TAB)).toBe(false);
  });
});
