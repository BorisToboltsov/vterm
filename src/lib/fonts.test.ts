import { describe, expect, it } from "vitest";
import { DEFAULT_FONT, RETRO_FONT, migrateFont, themeFont } from "./fonts";
import { THEMES } from "./themes";
import { activeFontFamily, applyImportedSettings, resetSettings, selectFont, settings } from "./settings.svelte";

describe("font preference", () => {
  it("follows every theme and custom", () => {
    resetSettings();
    for (const theme of THEMES) {
      settings.theme = theme.id;
      expect(activeFontFamily()).toBe(theme.group === "retro" ? RETRO_FONT : DEFAULT_FONT);
    }
    expect(themeFont("custom")).toBe(DEFAULT_FONT);
  });
  it("preserves an explicit choice across themes and backup import", () => {
    selectFont("'Fira Code', monospace");
    const snapshot = { fontMode: settings.fontMode, fontFamily: settings.fontFamily };
    for (const theme of THEMES) {
      settings.theme = theme.id;
      expect(activeFontFamily()).toBe(snapshot.fontFamily);
    }
    applyImportedSettings({ ...snapshot, theme: "fallout" });
    expect(activeFontFamily()).toBe(snapshot.fontFamily);
    settings.fontMode = "theme";
    expect(activeFontFamily()).toBe(RETRO_FONT);
  });
  it("migrates old defaults and removed fonts", () => {
    for (const fontFamily of [undefined, "", "'VT323', monospace", "'Press Start 2P', monospace", "ui-monospace, SFMono-Regular, Menlo, monospace"]) {
      expect(migrateFont({ fontFamily }).fontMode).toBe("theme");
    }
    expect(migrateFont({ fontFamily: RETRO_FONT }).fontMode).toBe("user");
    expect(migrateFont({ fontFamily: "Menlo, monospace", fontMode: "user" }).fontMode).toBe("user");
  });
});
