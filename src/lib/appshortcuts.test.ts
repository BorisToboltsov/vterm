import { describe, expect, it } from "vitest";
import {
  chordLetter,
  isAppShortcut,
  isFindChord,
  isHistoryChord,
  isNewTabChord,
  isPaletteChord,
  isTermCopyChord,
  isTermPasteChord,
} from "./appshortcuts";

/** Build a keydown-like chord; `key` case must match real events (Shift ⇒ upper). */
function chord(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; code?: string } = {},
) {
  return {
    key,
    code: mods.code,
    altKey: !!mods.alt,
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

// The same physical keys with the Russian layout active: `key` carries the
// Cyrillic letter, only `code` still names the Latin key.
const RU = { r: ["к", "KeyR"], t: ["е", "KeyT"], k: ["л", "KeyK"], f: ["а", "KeyF"], c: ["с", "KeyC"], v: ["м", "KeyV"] } as const;

describe("chordLetter", () => {
  it("returns the layout's Latin letter, lowercased", () => {
    expect(chordLetter({ key: "r" })).toBe("r");
    expect(chordLetter({ key: "R", code: "KeyR" })).toBe("r");
  });
  it("falls back to the physical key on a non-Latin layout", () => {
    expect(chordLetter({ key: "к", code: "KeyR" })).toBe("r");
    expect(chordLetter({ key: "К", code: "KeyR" })).toBe("r");
  });
  it("prefers the layout letter over the physical key (Dvorak/AZERTY keep their letters)", () => {
    // Dvorak: the physical "KeyB" position prints "x".
    expect(chordLetter({ key: "x", code: "KeyB" })).toBe("x");
  });
  it("is null for non-letter keys", () => {
    expect(chordLetter({ key: "Enter", code: "Enter" })).toBeNull();
    expect(chordLetter({ key: "1", code: "Digit1" })).toBeNull();
    expect(chordLetter({ key: "ж", code: "Semicolon" })).toBeNull();
    expect(chordLetter({ key: "к" })).toBeNull();
  });
});

describe("Russian layout", () => {
  const ru = (l: keyof typeof RU, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}) =>
    chord(mods.shift ? RU[l][0].toUpperCase() : RU[l][0], { ...mods, code: RU[l][1] });

  it("Ctrl+R opens the history overlay (Ctrl+К)", () => {
    expect(isHistoryChord(ru("r", { ctrl: true }))).toBe(true);
    expect(isHistoryChord(ru("r", { ctrl: true, shift: true }))).toBe(false);
    expect(isHistoryChord(ru("r", { meta: true }))).toBe(false);
  });
  it("app chords match on both platforms", () => {
    expect(isNewTabChord(ru("t", { meta: true }))).toBe(true);
    expect(isNewTabChord(ru("t", { ctrl: true, shift: true }))).toBe(true);
    expect(isPaletteChord(ru("k", { meta: true }))).toBe(true);
    expect(isPaletteChord(ru("k", { ctrl: true, shift: true }))).toBe(true);
    expect(isAppShortcut(ru("k", { meta: true }))).toBe(true);
  });
  it("plain Ctrl+T / Ctrl+K still belong to the shell", () => {
    expect(isAppShortcut(ru("t", { ctrl: true }))).toBe(false);
    expect(isAppShortcut(ru("k", { ctrl: true }))).toBe(false);
  });
  it("find / copy / paste match", () => {
    expect(isFindChord(ru("f", { meta: true }))).toBe(true);
    expect(isFindChord(ru("f", { ctrl: true, shift: true }))).toBe(true);
    expect(isTermCopyChord(ru("c", { meta: true }))).toBe(true);
    expect(isTermPasteChord(ru("v", { ctrl: true, shift: true }))).toBe(true);
  });
});

describe("terminal chords", () => {
  it("plain Ctrl+R only — no other modifier", () => {
    expect(isHistoryChord(chord("r", { ctrl: true }))).toBe(true);
    expect(isHistoryChord(chord("r", { ctrl: true, alt: true }))).toBe(false);
    expect(isHistoryChord(chord("r", {}))).toBe(false);
  });
  it("plain Ctrl+F / Ctrl+C / Ctrl+V stay with the shell", () => {
    expect(isFindChord(chord("f", { ctrl: true }))).toBe(false);
    expect(isTermCopyChord(chord("c", { ctrl: true }))).toBe(false);
    expect(isTermPasteChord(chord("v", { ctrl: true }))).toBe(false);
  });
  it("⌘ forms require no Shift", () => {
    expect(isFindChord(chord("F", { meta: true, shift: true }))).toBe(false);
    expect(isTermCopyChord(chord("c", { meta: true }))).toBe(true);
    expect(isTermPasteChord(chord("v", { meta: true }))).toBe(true);
  });
});
