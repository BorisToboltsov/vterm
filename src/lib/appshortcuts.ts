// Pure predicates for the app's window-level keyboard shortcuts that must work
// while the xterm terminal has focus. Single source of truth shared by the window
// handler (+page.svelte `onGlobalKey`) and the terminal's custom key handler
// (Terminal.svelte) — the two MUST agree, or a chord the window expects gets eaten
// by xterm as a control code (it sends the byte to the PTY and stopPropagation, so
// the window listener never fires).
//
// Platform split mirrors the existing search/copy/paste shortcuts (Cmd+F /
// Ctrl+Shift+F …): on macOS the chord uses ⌘ (metaKey), which xterm ignores, so it
// bubbles to the window on its own; on Windows/Linux the plain Ctrl+<key> form
// belongs to the shell (Ctrl+T = readline transpose-chars / fzf; Ctrl+K =
// kill-line), so the app uses Ctrl+Shift+<key> instead. `isAppShortcut` is what the
// terminal checks to RELEASE these chords (return false → let them bubble) without
// sending them to the shell — plain Ctrl+T / Ctrl+K stay with the shell.
//
// Layout independence: letters are compared through `chordLetter`, never through
// a raw `e.key === "t"`. On a non-Latin layout (Russian, Greek, Hebrew…) the same
// physical key reports `"е"` instead of `"t"`, and every chord silently stopped
// working the moment the user switched language (Ctrl+R fell through to the shell's
// reverse-search). `chordLetter` keeps `e.key` when it is a Latin letter — so
// Dvorak/AZERTY users still get the letter printed on the key — and only falls
// back to the physical `e.code` (`"KeyT"`) when the layout produced something else.
// The Shift state is read from `shiftKey`, not from the letter's case: with a
// non-Latin layout the case is carried by the Cyrillic letter, not the code.

/** The minimal shape read from a keydown event (DOM KeyboardEvent satisfies it). */
export interface KeyChord {
  key: string;
  /** Physical key (`"KeyR"`); optional so hand-built chords in tests stay terse. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}

/**
 * The Latin letter a chord was pressed on, lowercased, or `null` for non-letter
 * keys. Prefers the layout's own Latin letter (`e.key`), falls back to the
 * physical key (`e.code`) when the layout isn't Latin — so Ctrl+R works the same
 * with the Russian layout active.
 */
export function chordLetter(e: Pick<KeyChord, "key" | "code">): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** ⌘<letter> without Shift (macOS form). */
function metaChord(e: KeyChord, letter: string): boolean {
  return e.metaKey && !e.shiftKey && chordLetter(e) === letter;
}

/** Ctrl+Shift+<letter> (Windows/Linux form). */
function ctrlShiftChord(e: KeyChord, letter: string): boolean {
  return e.ctrlKey && e.shiftKey && chordLetter(e) === letter;
}

/** ⌘K (macOS) or Ctrl+Shift+K (Windows/Linux) — toggle the command palette. */
export function isPaletteChord(e: KeyChord): boolean {
  return metaChord(e, "k") || ctrlShiftChord(e, "k");
}

/** ⌘T (macOS) or Ctrl+Shift+T (Windows/Linux) — open a new tab. */
export function isNewTabChord(e: KeyChord): boolean {
  return metaChord(e, "t") || ctrlShiftChord(e, "t");
}

/**
 * Any window-level app chord the terminal must release so it reaches the window
 * handler instead of going to the PTY. Deliberately excludes plain Ctrl+T /
 * Ctrl+K — those belong to the shell.
 */
export function isAppShortcut(e: KeyChord): boolean {
  return isPaletteChord(e) || isNewTabChord(e);
}

/** ⌘F (macOS) or Ctrl+Shift+F (Windows/Linux) — full-buffer terminal search.
 *  Plain Ctrl+F stays with the shell (readline forward-char). */
export function isFindChord(e: KeyChord): boolean {
  return metaChord(e, "f") || ctrlShiftChord(e, "f");
}

/** ⌘C (macOS) or Ctrl+Shift+C (Windows/Linux) — terminal copy. Plain Ctrl+C is SIGINT. */
export function isTermCopyChord(e: KeyChord): boolean {
  return metaChord(e, "c") || ctrlShiftChord(e, "c");
}

/** ⌘V (macOS) or Ctrl+Shift+V (Windows/Linux) — terminal paste. */
export function isTermPasteChord(e: KeyChord): boolean {
  return metaChord(e, "v") || ctrlShiftChord(e, "v");
}

/** Plain Ctrl+V (no other modifier) — optional paste on Windows/Linux (`ctrlVPastes`). */
export function isPlainCtrlVChord(e: KeyChord): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && chordLetter(e) === "v";
}

/** Plain Ctrl+R (no other modifier) — the command-history overlay. */
export function isHistoryChord(e: KeyChord): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && chordLetter(e) === "r";
}
