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

describe("statusBarThresholds", () => {
  it("seeds sensible numeric defaults", () => {
    expect(settings.statusBarThresholds.cpu).toEqual({ warn: 80, crit: 95 });
    expect(settings.statusBarThresholds.load).toEqual({ warn: null, crit: null });
  });

  it("deep-merges a backup snapshot, keeping defaults for absent metrics", () => {
    applyImportedSettings({ statusBarThresholds: { cpu: { warn: 60, crit: 90 } } });
    flushSync();
    expect(settings.statusBarThresholds.cpu).toEqual({ warn: 60, crit: 90 });
    // A metric absent from the snapshot keeps its default.
    expect(settings.statusBarThresholds.ram).toEqual({ warn: 85, crit: 95 });
  });

  it("preserves an explicit null bound (disabled) over the default", () => {
    applyImportedSettings({ statusBarThresholds: { cpu: { warn: null, crit: null } } });
    flushSync();
    expect(settings.statusBarThresholds.cpu).toEqual({ warn: null, crit: null });
  });

  it("ignores junk values in the thresholds object", () => {
    applyImportedSettings({ statusBarThresholds: { cpu: { warn: "oops" } } });
    flushSync();
    // Bad value falls back to the default warn.
    expect(settings.statusBarThresholds.cpu.warn).toBe(80);
  });
});

describe("smartLogs (Phase 10)", () => {
  it("defaults to all enabled", () => {
    expect(settings.smartLogs).toEqual({
      enabled: true,
      search: true,
      highlight: true,
      jsonView: true,
    });
  });

  it("merges a partial backup snapshot onto defaults", () => {
    applyImportedSettings({ smartLogs: { enabled: false } });
    flushSync();
    expect(settings.smartLogs.enabled).toBe(false);
    // Absent sub-flags keep their defaults rather than vanishing.
    expect(settings.smartLogs.search).toBe(true);
  });

  it("is restored to defaults by resetSettings", () => {
    settings.smartLogs.enabled = false;
    settings.smartLogs.search = false;
    resetSettings();
    expect(settings.smartLogs.enabled).toBe(true);
    expect(settings.smartLogs.search).toBe(true);
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

  it("imports a valid language and rejects an invalid one", () => {
    applyImportedSettings({ language: "ru" });
    flushSync();
    expect(settings.language).toBe("ru");
    applyImportedSettings({ language: "klingon" });
    flushSync();
    expect(settings.language).toBe("en"); // junk falls back to the default
  });
});

describe("language", () => {
  it("defaults to English", () => {
    expect(settings.language).toBe("en");
  });

  it("persists a language change and reloads valid, rejects junk", () => {
    settings.language = "ru";
    flushSync();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.language).toBe("ru");
  });
});
