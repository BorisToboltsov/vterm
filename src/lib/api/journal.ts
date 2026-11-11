// The journal of notifications (ADR 0062): every message the app showed,
// kept by the backend for all the windows (`journal.rs`). A window notes what it
// said; every window hears `window://journal` when the journal changed and asks
// for the list only while it shows it. Called by the journal store
// (`stores/journal.svelte.ts`) alone.

import { invoke } from "@tauri-apps/api/core";
import type { JournalEntry, JournalKind, JournalSummary } from "../types";

/** Heard by every window after any change: a {@link JournalSummary}. */
export const JOURNAL_EVENT = "window://journal";

/** What a window asks the journal to keep. */
export interface JournalNote {
  kind: JournalKind;
  text: string;
  source?: string;
  serverId?: string;
  server?: string;
}

export function journalNote(note: JournalNote): Promise<JournalSummary> {
  return invoke<JournalSummary>("journal_note", { note });
}

/** Every entry, newest change first. */
export function journalList(): Promise<JournalEntry[]> {
  return invoke<JournalEntry[]>("journal_list");
}

export function journalSummary(): Promise<JournalSummary> {
  return invoke<JournalSummary>("journal_summary");
}

/** These entries — or, given none, every one — have been seen. */
export function journalMarkRead(ids: string[] | null = null): Promise<JournalSummary> {
  return invoke<JournalSummary>("journal_mark_read", { ids });
}

export function journalRemove(ids: string[]): Promise<JournalSummary> {
  return invoke<JournalSummary>("journal_remove", { ids });
}

export function journalClear(): Promise<JournalSummary> {
  return invoke<JournalSummary>("journal_clear");
}

/** Kept across launches or not, and for how many days. */
export function journalConfigure(persist: boolean, days: number): Promise<JournalSummary> {
  return invoke<JournalSummary>("journal_configure", { persist, days });
}
