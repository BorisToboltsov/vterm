import { getTheme } from "./themes";

export const DEFAULT_FONT = "'JetBrains Mono', monospace";
export const RETRO_FONT = "'Share Tech Mono', monospace";
export type FontMode = "theme" | "user";

export function themeFont(theme: string): string {
  return getTheme(theme).group === "retro" ? RETRO_FONT : DEFAULT_FONT;
}

/** Old snapshots did not distinguish explicit choices from theme defaults. */
export function migrateFont(raw: { fontFamily?: unknown; fontMode?: unknown }): {
  fontFamily: string; fontMode: FontMode;
} {
  const font = typeof raw.fontFamily === "string" ? raw.fontFamily.trim() : "";
  const removed = /VT323|Press Start 2P/i.test(font);
  const legacyDefault = font === "ui-monospace, SFMono-Regular, Menlo, monospace";
  const automatic = !font || removed || raw.fontMode === "theme" ||
    (raw.fontMode !== "user" && legacyDefault);
  return { fontMode: automatic ? "theme" : "user", fontFamily: automatic ? DEFAULT_FONT : font };
}
