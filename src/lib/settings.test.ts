import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTerminalTheme,
  applyImportedSettings,
  resetSettings,
  settings,
} from "./settings.svelte";
import { DEFAULT_THEME_ID, getTheme } from "./themes";

const STORAGE_KEY = "vterm.settings";

beforeEach(() => {
  localStorage.clear();
  resetSettings();
  flushSync();
});

describe("defaults", () => {
  it("loads sensible defaults", () => {
    expect(settings.theme).toBe(DEFAULT_THEME_ID);
    expect(settings.fontSize).toBe(13);
    expect(settings.connectTimeout).toBe(10);
    expect(settings.keepaliveInterval).toBe(15);
    expect(settings.defaultPort).toBe(22);
    expect(settings.hostKeyPolicy).toBe("ask");
    // The custom theme seeds from the default preset's terminal palette.
    expect(settings.customTheme).toEqual(getTheme(DEFAULT_THEME_ID).terminal);
  });
});

describe("persistence", () => {
  it("writes settings to localStorage on change", () => {
    settings.fontSize = 18;
    settings.theme = "dracula";
    flushSync();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.fontSize).toBe(18);
    expect(stored.theme).toBe("dracula");
  });
});

describe("activeTerminalTheme", () => {
  it("resolves a preset palette", () => {
    settings.theme = "nord";
    flushSync();
    expect(activeTerminalTheme()).toEqual(getTheme("nord").terminal);
  });

  it("returns the user's custom palette when theme is 'custom'", () => {
    settings.theme = "custom";
    settings.customTheme = { ...settings.customTheme, background: "#123456" };
    flushSync();
    expect(activeTerminalTheme().background).toBe("#123456");
  });
});

describe("resetSettings", () => {
  it("restores defaults after mutation", () => {
    settings.fontSize = 99;
    settings.theme = "amber";
    flushSync();
    resetSettings();
    flushSync();
    expect(settings.fontSize).toBe(13);
    expect(settings.theme).toBe(DEFAULT_THEME_ID);
  });
});

describe("applyImportedSettings", () => {
  it("applies known keys from a backup snapshot", () => {
    applyImportedSettings({ theme: "dracula", fontSize: 20, defaultPort: 2222 });
    flushSync();
    expect(settings.theme).toBe("dracula");
    expect(settings.fontSize).toBe(20);
    expect(settings.defaultPort).toBe(2222);
  });

  it("fills missing keys with defaults and merges customTheme", () => {
    settings.fontSize = 18;
    applyImportedSettings({ theme: "custom", customTheme: { background: "#abcdef" } });
    flushSync();
    expect(settings.theme).toBe("custom");
    expect(settings.customTheme.background).toBe("#abcdef");
    // A key absent from the snapshot reverts to its default.
    expect(settings.fontSize).toBe(13);
  });

  it("ignores junk and non-object input", () => {
    settings.theme = "nord";
    applyImportedSettings(null);
    applyImportedSettings("nope");
    applyImportedSettings({ notARealKey: 1 });
    flushSync();
    expect(settings.theme).toBe(DEFAULT_THEME_ID); // reset to default by the object call
    expect((settings as unknown as Record<string, unknown>).notARealKey).toBeUndefined();
  });
});
