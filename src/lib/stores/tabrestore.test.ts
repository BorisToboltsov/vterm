import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { addTab, emptyLayout, type CenterLayout } from "../splitlayout";
import { resetSettings, settings } from "../settings.svelte";
import { parseSavedWindow, slotKey } from "../tabrestore";
import { closeTab, openLocalTab, openTab, resetTabs, tabsState, type Tab } from "./tabs.svelte";
import { startSavingTabs, tabKeeper, takeSavedTabs } from "./tabrestore.svelte";

/** A storage of its own for a keeper under test. */
function memory(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const tab = (sessionId: string): Tab => ({
  sessionId,
  kind: "ssh",
  serverId: "srv",
  alias: "web-1",
  secret: "hunter2",
  remember: true,
  status: "Connected",
  gen: 0,
});
const layoutOf = (...ids: string[]): CenterLayout => ids.reduce((l, id) => addTab(l, id), emptyLayout());
const slot = (...ids: string[]) =>
  JSON.stringify({ v: 1, tabs: ids.map((id) => ({ id, kind: "ssh", serverId: "srv", alias: id })), layout: null });

describe("the main window's slot", () => {
  it("is not written before the previous launch has been taken in", () => {
    const store = memory({ [slotKey("main")]: slot("old") });
    const keeper = tabKeeper("main", store);
    expect(keeper.writing).toBe(false);
    // The store of tabs is still empty: writing now would wipe what was saved.
    keeper.sync([], emptyLayout(), "manual");
    expect(store.data.get(slotKey("main"))).toBe(slot("old"));
    keeper.sync([tab("new")], layoutOf("new"), "manual");
    expect(store.data.get(slotKey("main"))).toBe(slot("old"));
  });

  it("gives up what the previous launch left — its own slot and the other windows' — once", () => {
    const store = memory({
      [slotKey("main")]: slot("m"),
      [slotKey("win-2")]: slot("w2"),
      [slotKey("win-3")]: slot("w3"),
      "vterm.settings": "{}",
    });
    const keeper = tabKeeper("main", store);
    const taken = keeper.take("manual");
    expect(parseSavedWindow(taken?.main)?.tabs.map((t) => t.id)).toEqual(["m"]);
    expect(taken?.others.map((o) => parseSavedWindow(o)?.tabs[0].id)).toEqual(["w2", "w3"]);
    expect(keeper.take("manual")).toBeNull();
  });

  it("gives nothing when restoring is off or nothing was saved", () => {
    expect(tabKeeper("main", memory({ [slotKey("main")]: slot("m") })).take("off")).toBeNull();
    expect(tabKeeper("main", memory()).take("connect")).toBeNull();
    expect(tabKeeper("main", memory({ [slotKey("main")]: "{not json" })).take("connect")).toBeNull();
  });

  it("starting to save drops the slots of the windows that are gone, and nothing else", () => {
    const store = memory({
      [slotKey("main")]: slot("m"),
      [slotKey("win-2")]: slot("w2"),
      "vterm.settings": "{}",
      "vterm.layout": "{}",
    });
    const keeper = tabKeeper("main", store);
    keeper.take("manual");
    // Until the page has applied what it took, the other slots are still there.
    expect(store.data.has(slotKey("win-2"))).toBe(true);
    keeper.start();
    expect([...store.data.keys()].sort()).toEqual(["vterm.layout", "vterm.settings", slotKey("main")]);
    expect(keeper.writing).toBe(true);
  });

  it("once saving, holds the tabs and their layout — and no secret", () => {
    const store = memory();
    const keeper = tabKeeper("main", store);
    keeper.start();
    keeper.sync([tab("a"), tab("b")], layoutOf("a", "b"), "manual");
    const raw = store.data.get(slotKey("main")) ?? "";
    expect(raw).not.toContain("hunter2");
    const read = parseSavedWindow(JSON.parse(raw));
    expect(read?.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(read?.layout).toMatchObject({ focus: "p0" });
  });

  it("is cleared when the last tab goes, and when restoring is turned off", () => {
    const store = memory();
    const keeper = tabKeeper("main", store);
    keeper.start();
    keeper.sync([tab("a")], layoutOf("a"), "connect");
    expect(store.data.has(slotKey("main"))).toBe(true);
    keeper.sync([], emptyLayout(), "connect");
    expect(store.data.has(slotKey("main"))).toBe(false);
    keeper.sync([tab("a")], layoutOf("a"), "connect");
    keeper.sync([tab("a")], layoutOf("a"), "off");
    expect(store.data.has(slotKey("main"))).toBe(false);
  });
});

describe("the slot of a window a tab was moved out to", () => {
  it("is written from the start, and under the window's own name", () => {
    const store = memory({ [slotKey("main")]: slot("m") });
    const keeper = tabKeeper("win-2", store);
    expect(keeper.writing).toBe(true);
    keeper.sync([tab("w")], layoutOf("w"), "manual");
    expect(parseSavedWindow(JSON.parse(store.data.get(slotKey("win-2")) ?? "null"))?.tabs[0].id).toBe("w");
    expect(store.data.get(slotKey("main"))).toBe(slot("m"));
  });

  it("restores nothing and removes nobody's slot", () => {
    const store = memory({ [slotKey("main")]: slot("m"), [slotKey("win-3")]: slot("w3") });
    const keeper = tabKeeper("win-2", store);
    expect(keeper.take("connect")).toBeNull();
    keeper.start();
    expect(store.data.has(slotKey("main"))).toBe(true);
    expect(store.data.has(slotKey("win-3"))).toBe(true);
  });

  it("is forgotten when the window is closed on purpose — and stays forgotten", () => {
    const store = memory();
    const keeper = tabKeeper("win-2", store);
    keeper.sync([tab("w")], layoutOf("w"), "manual");
    keeper.forget();
    expect(store.data.has(slotKey("win-2"))).toBe(false);
    // The page is still alive for a moment after the window was told to close.
    keeper.sync([tab("w")], layoutOf("w"), "manual");
    expect(store.data.has(slotKey("win-2"))).toBe(false);
  });
});

describe("a storage that fails", () => {
  it("is not fatal: nothing is restored, nothing is thrown", () => {
    const broken = {
      get length(): number {
        throw new Error("denied");
      },
      key: () => null,
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const keeper = tabKeeper("main", broken);
    expect(keeper.take("manual")).toBeNull();
    expect(() => keeper.start()).not.toThrow();
    expect(() => keeper.sync([tab("a")], layoutOf("a"), "manual")).not.toThrow();
    expect(() => keeper.sync([], emptyLayout(), "manual")).not.toThrow();
    expect(() => keeper.forget()).not.toThrow();
  });
});

// The window the tests run in is the main one (no Tauri window to ask).
describe("this window's slot follows the tabs", () => {
  const own = slotKey("main");
  const stored = () => parseSavedWindow(JSON.parse(localStorage.getItem(own) ?? "null"));

  beforeEach(() => {
    resetTabs();
    resetSettings();
    flushSync();
  });

  it("from the moment the previous launch was taken in", () => {
    localStorage.setItem(own, slot("old"));
    openLocalTab();
    flushSync();
    // Not yet: the page has not restored.
    expect(stored()?.tabs.map((t) => t.id)).toEqual(["old"]);

    expect(parseSavedWindow(takeSavedTabs()?.main)?.tabs[0].id).toBe("old");
    startSavingTabs();
    flushSync();
    expect(stored()?.tabs).toHaveLength(1);
    expect(stored()?.tabs[0].kind).toBe("local");

    const id = openTab("srv", "web-1", "hunter2", true);
    flushSync();
    expect(stored()?.tabs.map((t) => t.kind)).toEqual(["local", "ssh"]);
    expect(localStorage.getItem(own)).not.toContain("hunter2");

    closeTab(id);
    flushSync();
    expect(stored()?.tabs).toHaveLength(1);

    settings.restoreTabs = "off";
    flushSync();
    expect(localStorage.getItem(own)).toBeNull();

    settings.restoreTabs = "connect";
    flushSync();
    expect(stored()?.tabs).toHaveLength(1);

    closeTab(tabsState.list[0].sessionId);
    flushSync();
    expect(localStorage.getItem(own)).toBeNull();
  });
});
