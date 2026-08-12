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
// Note on case: with Shift held a letter key reports uppercase (`"T"`), without it
// lowercase (`"t"`). So the ⌘ branch matching lowercase inherently means no Shift,
// and the Ctrl+Shift branch matching uppercase inherently means Shift — same idiom
// the search combo already relies on.

/** The minimal shape read from a keydown event (DOM KeyboardEvent satisfies it). */
export interface KeyChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** ⌘K (macOS) or Ctrl+Shift+K (Windows/Linux) — toggle the command palette. */
export function isPaletteChord(e: KeyChord): boolean {
  return (e.metaKey && e.key === "k") || (e.ctrlKey && e.shiftKey && e.key === "K");
}

/** ⌘T (macOS) or Ctrl+Shift+T (Windows/Linux) — open a new tab. */
export function isNewTabChord(e: KeyChord): boolean {
  return (e.metaKey && e.key === "t") || (e.ctrlKey && e.shiftKey && e.key === "T");
}

/**
 * Any window-level app chord the terminal must release so it reaches the window
 * handler instead of going to the PTY. Deliberately excludes plain Ctrl+T /
 * Ctrl+K — those belong to the shell.
 */
export function isAppShortcut(e: KeyChord): boolean {
  return isPaletteChord(e) || isNewTabChord(e);
}
