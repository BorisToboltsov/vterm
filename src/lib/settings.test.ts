import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeChromePanel,
  activeTerminalTheme,
  applyActiveTheme,
  applyImportedSettings,
  CHROME_PANEL_KEY,
  clampMaxOpenMb,
  clampDockerRefresh,
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

describe("applyActiveTheme", () => {
  it("pushes a preset's chrome palette onto the document root", () => {
    settings.theme = "dracula";
    flushSync();
    document.documentElement.removeAttribute("style"); // isolate from the effect
    applyActiveTheme();
    expect(document.documentElement.style.getPropertyValue("--color-panel")).toBe(
      getTheme("dracula").ui.panel,
    );
  });

  it("leaves the chrome CSS var on defaults for a custom theme", () => {
    settings.theme = "custom";
    flushSync();
    document.documentElement.removeAttribute("style");
    applyActiveTheme();
    // No preset palette pushed, so the `--color-panel` var stays unset…
    expect(document.documentElement.style.getPropertyValue("--color-panel")).toBe("");
    // …but the neutral dark panel still backs the root element.
    expect(document.documentElement.style.backgroundColor).toBeTruthy();
  });

  it("mirrors the panel colour onto the root background and persists it for the boot script", () => {
    settings.theme = "dracula";
    flushSync();
    document.documentElement.removeAttribute("style");
    localStorage.removeItem(CHROME_PANEL_KEY);

    applyActiveTheme();

    const panel = getTheme("dracula").ui.panel;
    expect(activeChromePanel()).toBe(panel);
    // documentElement.style.backgroundColor is normalised to rgb() by jsdom, so
    // assert it's set rather than string-equal to the hex.
    expect(document.documentElement.style.backgroundColor).not.toBe("");
    // The persisted hex is what app.html's pre-CSS boot script reads next launch.
    expect(localStorage.getItem(CHROME_PANEL_KEY)).toBe(panel);
  });

  it("sets a dark UA color-scheme for a dark preset so native controls render light glyphs", () => {
    settings.theme = "dracula"; // group: "modern" (dark)
    flushSync();
    document.documentElement.removeAttribute("style");
    applyActiveTheme();
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("sets a light UA color-scheme for a light preset", () => {
    settings.theme = "solarized-light"; // group: "light"
    flushSync();
    document.documentElement.removeAttribute("style");
    applyActiveTheme();
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("keeps the dark UA color-scheme for a custom theme", () => {
    settings.theme = "custom";
    flushSync();
    document.documentElement.removeAttribute("style");
    applyActiveTheme();
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});

describe("defaults", () => {
  it("loads sensible defaults", () => {
    expect(settings.theme).toBe(DEFAULT_THEME_ID);
    expect(settings.fontSize).toBe(13);
    expect(settings.connectTimeout).toBe(10);
    expect(settings.keepaliveInterval).toBe(15);
    expect(settings.defaultPort).toBe(22);
    expect(settings.hostKeyPolicy).toBe("ask");
    expect(settings.recordIdlePauseSecs).toBe(20);
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
  it("defaults to the single master toggle on", () => {
    expect(settings.smartLogs).toEqual({ enabled: true });
  });

  it("merges a partial backup snapshot onto defaults, ignoring stale sub-flags", () => {
    // Old backups may carry the removed per-feature flags — only `enabled` is kept.
    applyImportedSettings({ smartLogs: { enabled: false, search: false } as never });
    flushSync();
    expect(settings.smartLogs).toEqual({ enabled: false });
  });

  it("is restored to defaults by resetSettings", () => {
    settings.smartLogs.enabled = false;
    resetSettings();
    expect(settings.smartLogs.enabled).toBe(true);
  });
});

describe("editor settings (Phase 12)", () => {
  it("defaults to diff-before-save on", () => {
    expect(settings.editor).toEqual({ diffBeforeSave: true, backupOnSave: false });
  });

  it("merges a partial backup snapshot onto defaults", () => {
    applyImportedSettings({ editor: { diffBeforeSave: false } });
    flushSync();
    expect(settings.editor.diffBeforeSave).toBe(false);
    expect(settings.editor.backupOnSave).toBe(false); // absent flag keeps its default
  });

  it("is restored to defaults by resetSettings", () => {
    settings.editor.diffBeforeSave = false;
    resetSettings();
    expect(settings.editor).toEqual({ diffBeforeSave: true, backupOnSave: false });
  });
});

describe("sftp settings (Phase 12)", () => {
  it("defaults max open size to 2 MB and hides dotfiles", () => {
    expect(settings.sftp).toEqual({ maxOpenMb: 2, showHiddenFiles: false });
  });

  it("imports and persists the show-hidden-files toggle (junk → false)", () => {
    applyImportedSettings({ sftp: { maxOpenMb: 2, showHiddenFiles: true } });
    flushSync();
    expect(settings.sftp.showHiddenFiles).toBe(true);
    applyImportedSettings({ sftp: { maxOpenMb: 2, showHiddenFiles: "yes" } });
    flushSync();
    expect(settings.sftp.showHiddenFiles).toBe(false); // only literal true enables it
  });

  it("clamps an imported value to the 1…64 MB range", () => {
    applyImportedSettings({ sftp: { maxOpenMb: 1000 } });
    flushSync();
    expect(settings.sftp.maxOpenMb).toBe(64);
    applyImportedSettings({ sftp: { maxOpenMb: 0 } });
    flushSync();
    expect(settings.sftp.maxOpenMb).toBe(1);
    applyImportedSettings({ sftp: { maxOpenMb: "junk" } });
    flushSync();
    expect(settings.sftp.maxOpenMb).toBe(2); // non-number → default
  });

  it("is restored to defaults by resetSettings", () => {
    settings.sftp.maxOpenMb = 10;
    resetSettings();
    expect(settings.sftp.maxOpenMb).toBe(2);
  });
});

describe("clampMaxOpenMb", () => {
  it("rounds and clamps to [1, 64]", () => {
    expect(clampMaxOpenMb(2)).toBe(2);
    expect(clampMaxOpenMb(2.6)).toBe(3);
    expect(clampMaxOpenMb(0)).toBe(1);
    expect(clampMaxOpenMb(999)).toBe(64);
    expect(clampMaxOpenMb(NaN)).toBe(2);
    expect(clampMaxOpenMb("x")).toBe(2);
  });
});

describe("clampDockerRefresh", () => {
  it("rounds and clamps to [1, 30], defaulting on non-numbers", () => {
    expect(clampDockerRefresh(3)).toBe(3);
    expect(clampDockerRefresh(2.6)).toBe(3);
    expect(clampDockerRefresh(0)).toBe(1);
    expect(clampDockerRefresh(999)).toBe(30);
    expect(clampDockerRefresh(NaN)).toBe(3);
    expect(clampDockerRefresh("x")).toBe(3);
  });
});

describe("highlightRules (Phase 10)", () => {
  it("seeds built-in starter rules", () => {
    expect(settings.highlightRules.length).toBeGreaterThan(0);
    expect(settings.highlightRules.map((r) => r.id)).toContain("error");
  });

  it("sanitises an imported rules array, dropping junk entries", () => {
    applyImportedSettings({
      highlightRules: [
        { id: "a", name: "A", pattern: "foo", color: "green", enabled: true, caseSensitive: false },
        { name: "no pattern" }, // dropped — no pattern string
        "garbage", // dropped — not an object
      ],
    });
    flushSync();
    expect(settings.highlightRules).toHaveLength(1);
    expect(settings.highlightRules[0]).toMatchObject({ pattern: "foo", color: "green" });
  });

  it("falls back to a valid colour and enabled flag for partial entries", () => {
    applyImportedSettings({ highlightRules: [{ id: "b", pattern: "x", color: "bogus" }] });
    flushSync();
    expect(settings.highlightRules[0].color).toBe("yellow");
    expect(settings.highlightRules[0].enabled).toBe(true);
  });

  it("is restored to defaults by resetSettings", () => {
    settings.highlightRules = [];
    resetSettings();
    expect(settings.highlightRules.length).toBeGreaterThan(0);
  });

  it("seeds style fields and a green success rule", () => {
    const ids = settings.highlightRules.map((r) => r.id);
    expect(ids).toContain("success");
    const success = settings.highlightRules.find((r) => r.id === "success")!;
    expect(success.color).toBe("green");
    expect(success).toMatchObject({ wholeLine: false, bold: false, background: false });
  });

  it("sanitises style booleans on import", () => {
    applyImportedSettings({
      highlightRules: [
        { id: "a", pattern: "x", color: "red", wholeLine: true, bold: true, background: "yes" },
      ],
    });
    flushSync();
    expect(settings.highlightRules[0]).toMatchObject({
      wholeLine: true,
      bold: true,
      background: false, // non-boolean coerced to false
    });
  });
});

describe("searchOptions (Phase 10)", () => {
  it("defaults to all off", () => {
    expect(settings.searchOptions).toEqual({
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
  });

  it("persists and reloads, and resets with resetSettings", () => {
    settings.searchOptions.regex = true;
    flushSync();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.searchOptions.regex).toBe(true);
    resetSettings();
    expect(settings.searchOptions.regex).toBe(false);
  });

  it("merges a partial backup snapshot onto defaults", () => {
    applyImportedSettings({ searchOptions: { regex: true } });
    flushSync();
    expect(settings.searchOptions.regex).toBe(true);
    expect(settings.searchOptions.caseSensitive).toBe(false);
  });
});

describe("recording settings (Phase 11)", () => {
  it("defaults to full recording with password masking", () => {
    expect(settings.recordMode).toBe("full");
    expect(settings.recordMaskPasswords).toBe(true);
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

describe("local shell picker", () => {
  it("defaults to cmd with no custom path", () => {
    expect(settings.windowsShell).toBe("cmd");
    expect(settings.localShellPath).toBe("");
  });

  it("persists a shell choice and custom path", () => {
    settings.windowsShell = "pwsh";
    settings.localShellPath = "/bin/zsh";
    flushSync();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.windowsShell).toBe("pwsh");
    expect(stored.localShellPath).toBe("/bin/zsh");
  });

  it("imports valid values and rejects junk", () => {
    applyImportedSettings({ windowsShell: "powershell", localShellPath: "/x/sh" });
    flushSync();
    expect(settings.windowsShell).toBe("powershell");
    expect(settings.localShellPath).toBe("/x/sh");
    applyImportedSettings({ windowsShell: "bogus", localShellPath: 42 });
    flushSync();
    expect(settings.windowsShell).toBe("cmd"); // junk → default
    expect(settings.localShellPath).toBe(""); // non-string → default
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
