// The journal of notifications in this window (ADR 0062). The journal is the
// backend's, one for all the windows (`journal.rs`); a window keeps what it
// needs to draw it: the summary every window hears (the bell's dot), and the
// list — asked for only while something here shows it (the bell's popover, the
// Journal section of Settings), and again when it changed meanwhile. Every toast
// is noted here first (`stores/toasts`).

import { writtenByCall } from "../api/call";
import { swallow } from "../api/diag";
import { listen } from "@tauri-apps/api/event";
import {
  JOURNAL_EVENT,
  journalClear,
  journalConfigure,
  journalList,
  journalMarkRead,
  journalNote,
  journalRemove,
  journalSummary,
  type JournalNote,
} from "../api/journal";
import type { JournalEntry, JournalSummary } from "../types";
import { NO_FILTER, type ListFilter } from "../ui/listview";

const EMPTY: JournalSummary = { rev: 0, total: 0, unreadErrors: false };

export const journalState = $state<{
  summary: JournalSummary;
  /** The list as last read; empty until something first shows it. */
  entries: JournalEntry[];
  /** The bell's popover is open. */
  open: boolean;
  /** What was unread when the list was first shown: those rows stay marked while it is. */
  fresh: string[];
  /** What the list is narrowed to; kept while the window lives. */
  filter: ListFilter;
}>({ summary: EMPTY, entries: [], open: false, fresh: [], filter: NO_FILTER });

/** How many views show the list now. */
let watching = 0;
/** The revision the list on hand was read at. */
let readAt = -1;
let reading: Promise<void> | null = null;
let again = false;

/** Take a summary the backend answered or announced; the same one changes nothing. */
function heard(summary: JournalSummary): void {
  const now = journalState.summary;
  if (summary.rev === now.rev && summary.total === now.total && summary.unreadErrors === now.unreadErrors) return;
  journalState.summary = summary;
  if (watching > 0 && summary.rev !== readAt) void reload();
}

/** Read the list again — once at a time, and once more if it changed meanwhile. */
function reload(): Promise<void> {
  if (reading) {
    again = true;
    return reading;
  }
  reading = (async () => {
    do {
      again = false;
      const rev = journalState.summary.rev;
      try {
        journalState.entries = await journalList();
        readAt = rev;
      } catch {
        /* the list on hand stays */
        writtenByCall();
      }
    } while (again);
    reading = null;
  })();
  return reading;
}

/** Hear the journal in this window; returns the way to stop. */
export function startJournal(): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  listen<JournalSummary>(JOURNAL_EVENT, (e) => heard(e.payload))
    .then((un) => (stopped ? un() : (stop = un)))
    .catch(swallow("app", "the journal will not be heard in this window"));
  journalSummary().then(heard).catch(writtenByCall);
  return () => {
    stopped = true;
    stop?.();
  };
}

/**
 * Keep a message in the journal. Never throws and never waits: a toast must
 * not fail because the journal could not take it.
 */
export function noteJournal(note: JournalNote): void {
  void Promise.resolve()
    .then(() => journalNote(note))
    .then((s) => s && heard(s))
    .catch(writtenByCall);
}

/**
 * A view shows the list from now on: read it, and — the first view to — mark
 * what was unread as seen, keeping it marked while the list is shown. Returns
 * the way to stop showing it.
 */
export function watchJournal(): () => void {
  watching += 1;
  const first = watching === 1;
  void (async () => {
    await reload();
    if (!first || watching === 0) return;
    journalState.fresh = journalState.entries.filter((e) => !e.read).map((e) => e.id);
    if (journalState.fresh.length > 0 || journalState.summary.unreadErrors) {
      try {
        heard(await journalMarkRead(null));
      } catch {
        /* the dot stays until the next try */
        writtenByCall();
      }
    }
  })();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watching = Math.max(0, watching - 1);
    if (watching === 0) journalState.fresh = [];
  };
}

/** Open the bell's popover (its list watches the journal while it is shown). */
export function openJournal(): void {
  journalState.open = true;
}

export function closeJournal(): void {
  journalState.open = false;
}

export function toggleJournal(): void {
  journalState.open = !journalState.open;
}

export function setJournalFilter(filter: ListFilter): void {
  journalState.filter = filter;
}

/** Remove these entries from the journal of every window. */
export async function removeFromJournal(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  heard(await journalRemove(ids));
}

/** Remove every entry from the journal of every window. */
export async function clearJournal(): Promise<void> {
  heard(await journalClear());
}

/** What the settings say (the main window tells the backend). */
export function configureJournal(persist: boolean, days: number): void {
  journalConfigure(persist, days).then(heard).catch(writtenByCall);
}
