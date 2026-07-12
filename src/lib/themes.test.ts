import { describe, expect, it } from "vitest";
import {
  applyUiPalette,
  DEFAULT_THEME_ID,
  getTheme,
  THEMES,
  themeSwatches,
  type TerminalTheme,
  type UiPalette,
} from "./themes";

const TERMINAL_KEYS: (keyof TerminalTheme)[] = [
  "background", "foreground", "cursor", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
const UI_KEYS: (keyof UiPalette)[] = [
  "panel", "panelAlt", "edge", "accent", "accentHover", "danger", "muted", "text",
];

const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
const isRgba = (v: string) => /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(v);

describe("theme catalogue integrity", () => {
  it("has a unique id per theme", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(THEMES.map((t) => [t.name, t] as const))(
    "%s has a valid colour for every palette key",
    (_name, theme) => {
      // Terminal colours feed xterm.js and must stay plain hex on every theme.
      for (const k of TERMINAL_KEYS) {
        expect(theme.terminal[k], `terminal.${k}`).toSatisfy(isHex);
      }
      // Signature themes use translucent (rgba) chrome panels so the backdrop
      // breathes through; classic themes keep flat hex chrome.
      const uiOk = theme.group === "signature" ? (v: string) => isHex(v) || isRgba(v) : isHex;
      for (const k of UI_KEYS) {
        expect(theme.ui[k], `ui.${k}`).toSatisfy(uiOk);
      }
      expect(["light", "modern", "retro", "signature"]).toContain(theme.group);
    },
  );
});

describe("signature themes", () => {
  const signature = THEMES.filter((t) => t.group === "signature");

  it("ships the three signature themes", () => {
    expect(signature.map((t) => t.id)).toEqual(["deep-well", "aurora", "glass"]);
  });

  it("every signature theme carries a logo backdrop + window overlay; no classic theme does", () => {
    for (const t of THEMES) {
      if (t.group === "signature") {
        expect(t.backdrop, `${t.id}.backdrop`).toBeTruthy();
        expect(t.overlay, `${t.id}.overlay`).toBeTruthy();
      } else {
        expect(t.backdrop, `${t.id}.backdrop`).toBeUndefined();
        expect(t.overlay, `${t.id}.overlay`).toBeUndefined();
      }
    }
  });
});

describe("light themes", () => {
  it("ships at least one light theme", () => {
    expect(THEMES.some((t) => t.group === "light")).toBe(true);
  });
});

describe("themeSwatches", () => {
  it("returns six representative hex colors from the terminal palette", () => {
    const sw = themeSwatches(getTheme("nord"));
    expect(sw).toHaveLength(6);
    for (const c of sw) expect(c).toSatisfy(isHex);
    expect(sw[0]).toBe(getTheme("nord").terminal.background);
  });
});

describe("default theme", () => {
  it("is Deep Well", () => {
    expect(DEFAULT_THEME_ID).toBe("deep-well");
    expect(getTheme(DEFAULT_THEME_ID).name).toBe("Deep Well");
  });
});

describe("getTheme", () => {
  it("returns the requested theme", () => {
    expect(getTheme("dracula").id).toBe("dracula");
  });
  it("falls back to the default for an unknown id", () => {
    expect(getTheme("does-not-exist").id).toBe(DEFAULT_THEME_ID);
  });
});

describe("applyUiPalette", () => {
  it("writes every UI color onto the document root as a CSS variable", () => {
    const ui = getTheme("nord").ui;
    applyUiPalette(ui);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--color-panel")).toBe(ui.panel);
    expect(style.getPropertyValue("--color-accent")).toBe(ui.accent);
    expect(style.getPropertyValue("--color-text")).toBe(ui.text);
    expect(style.getPropertyValue("--color-accent-hover")).toBe(ui.accentHover);
  });
});
