import { describe, expect, it } from "vitest";
import { isAppShortcut, isNewTabChord, isPaletteChord } from "./appshortcuts";

/** Build a keydown-like chord; `key` case must match real events (Shift ⇒ upper). */
function chord(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
) {
  return {
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
  };
}

describe("isNewTabChord", () => {
  it("matches ⌘T on macOS", () => {
    expect(isNewTabChord(chord("t", { meta: true }))).toBe(true);
  });
  it("matches Ctrl+Shift+T on Windows/Linux (uppercase key with Shift)", () => {
    expect(isNewTabChord(chord("T", { ctrl: true, shift: true }))).toBe(true);
  });
  it("does NOT match plain Ctrl+T — it belongs to the shell", () => {
    expect(isNewTabChord(chord("t", { ctrl: true }))).toBe(false);
  });
  it("does not match the palette chord or unrelated combos", () => {
    expect(isNewTabChord(chord("K", { ctrl: true, shift: true }))).toBe(false);
    expect(isNewTabChord(chord("F", { ctrl: true, shift: true }))).toBe(false);
    expect(isNewTabChord(chord("t", {}))).toBe(false);
  });
});

describe("isPaletteChord", () => {
  it("matches ⌘K on macOS", () => {
    expect(isPaletteChord(chord("k", { meta: true }))).toBe(true);
  });
  it("matches Ctrl+Shift+K on Windows/Linux", () => {
    expect(isPaletteChord(chord("K", { ctrl: true, shift: true }))).toBe(true);
  });
  it("does NOT match plain Ctrl+K — it belongs to the shell (kill-line)", () => {
    expect(isPaletteChord(chord("k", { ctrl: true }))).toBe(false);
  });
  it("does not match the new-tab chord", () => {
    expect(isPaletteChord(chord("T", { ctrl: true, shift: true }))).toBe(false);
  });
});

describe("isAppShortcut", () => {
  it("is true for every app chord the terminal must release", () => {
    expect(isAppShortcut(chord("t", { meta: true }))).toBe(true);
    expect(isAppShortcut(chord("k", { meta: true }))).toBe(true);
    expect(isAppShortcut(chord("T", { ctrl: true, shift: true }))).toBe(true);
    expect(isAppShortcut(chord("K", { ctrl: true, shift: true }))).toBe(true);
  });
  it("is false for the plain Ctrl keys that stay with the shell", () => {
    expect(isAppShortcut(chord("t", { ctrl: true }))).toBe(false);
    expect(isAppShortcut(chord("k", { ctrl: true }))).toBe(false);
  });
  it("is false for the search chord (handled separately by the terminal)", () => {
    expect(isAppShortcut(chord("F", { ctrl: true, shift: true }))).toBe(false);
  });
});
