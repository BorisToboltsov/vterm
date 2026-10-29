import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { resetSettings, settings } from "../settings/settings.svelte";
import { DEFAULT_TOPBAR } from "../topbar/topbaractions";
import { isPinned, moveAction, pinAction, resetTopbar, unpinAction } from "./topbarpins.svelte";

beforeEach(() => {
  localStorage.clear();
  resetSettings();
  flushSync();
});

describe("the user's top-bar buttons", () => {
  it("starts as the bar always was", () => {
    expect(settings.topbar).toEqual([...DEFAULT_TOPBAR]);
    expect(isPinned("record")).toBe(true);
    expect(isPinned("util:cidr")).toBe(false);
  });

  it("puts a tool on the bar, before Settings, and takes it off again", () => {
    pinAction("util:cidr");
    expect(settings.topbar.slice(-2)).toEqual(["util:cidr", "settings"]);
    expect(isPinned("util:cidr")).toBe(true);
    unpinAction("util:cidr");
    expect(settings.topbar).toEqual([...DEFAULT_TOPBAR]);
  });

  it("does not take Utilities or Settings off, however it is asked", () => {
    unpinAction("settings");
    unpinAction("utilities");
    for (const id of [...settings.topbar]) unpinAction(id);
    expect(settings.topbar).toEqual(["utilities", "settings"]);
  });

  it("moves a button to another place", () => {
    moveAction("settings", 0);
    expect(settings.topbar[0]).toBe("settings");
    moveAction("broadcast", settings.topbar.length);
    expect(settings.topbar.at(-1)).toBe("broadcast");
  });

  it("a request that changes nothing leaves the list object alone", () => {
    const before = settings.topbar;
    pinAction("record");
    unpinAction("util:cidr");
    unpinAction("settings");
    moveAction("record", settings.topbar.indexOf("record"));
    moveAction("util:cidr", 0);
    resetTopbar();
    expect(settings.topbar).toBe(before);
  });

  it("goes back to the default bar", () => {
    unpinAction("monitoring");
    pinAction("util:jwt");
    moveAction("settings", 0);
    resetTopbar();
    expect(settings.topbar).toEqual([...DEFAULT_TOPBAR]);
  });

  it("is saved with the settings and read back clean", () => {
    pinAction("util:tls");
    unpinAction("recordings");
    flushSync();
    const stored = JSON.parse(localStorage.getItem("vterm.settings") ?? "{}");
    expect(stored.topbar).toEqual(settings.topbar);
    expect(stored.topbar).toContain("util:tls");
    expect(stored.topbar).not.toContain("recordings");
  });
});
