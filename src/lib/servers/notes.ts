// Pure helpers for the per-server notes editor (DOM/network-free → unit-tested).
// The editor itself (NotesModal) owns the textarea, Markdown preview and the
// debounced autosave; here we keep only the small pure bits: counting and the
// dirty check that drive the footer and the "unsaved/saving/saved" status.

/** Simple counts shown under the notes editor. */
export interface NoteStats {
  /** Unicode code points (so emoji count as one, not two UTF-16 units). */
  chars: number;
  /** Whitespace-separated words; 0 for blank/whitespace-only text. */
  words: number;
  /** Line count; 0 for an empty string, else `split("\n").length`. */
  lines: number;
  /** True when the note is empty or only whitespace. */
  empty: boolean;
}

export function noteStats(text: string): NoteStats {
  const trimmed = text.trim();
  return {
    chars: [...text].length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: text === "" ? 0 : text.split("\n").length,
    empty: trimmed === "",
  };
}

/** Whether the buffer differs from the last saved value (exact comparison). */
export function notesDirty(current: string, saved: string): boolean {
  return current !== saved;
}

/** Whether a server has any non-blank notes (drives the tree/topbar indicator). */
export function hasNotes(notes: string | null | undefined): boolean {
  return !!notes && notes.trim() !== "";
}

/**
 * Which server the top-bar notes button targets. When an SSH tab is focused its
 * server wins (so notes follow the active tab); on a local tab (or with no tab)
 * `activeServer` is null and we fall back to the tree-selected server.
 */
export function notesTarget<T>(activeServer: T | null, selected: T | null): T | null {
  return activeServer ?? selected;
}
