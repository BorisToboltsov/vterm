// The journal of notifications, as the windows see it (ADR 0062): what a
// message is about (its source, its server), how many toasts a window shows at
// once, and the journal as a list of ADR 0050 — narrowed by the filter row,
// grouped by day. Pure: the journal itself is the backend's (`journal.rs`), the
// words are the component's.

import type { JournalEntry, JournalKind } from "../types";
import type { IconName } from "../ui/icons";
import type { ListSchema } from "../ui/listview";

/** What stands for the journal: its button, its group of Settings, its empty state. */
export const JOURNAL_ICON: IconName = "book";

/**
 * The parts of the app a message can come from. An id, kept in the journal as
 * it is and named in the reader's language when shown (`journal.source.*`).
 */
export const JOURNAL_SOURCES = [
  "connection",
  "terminal",
  "files",
  "editor",
  "transfer",
  "sync",
  "git",
  "docker",
  "k8s",
  "recording",
  "ai",
  "netcheck",
  "monitoring",
  "servers",
  "settings",
  "update",
  "windows",
  // The app itself: start-up, exit, an internal error (ADR 0063).
  "app",
] as const;

export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export const isJournalSource = (v: unknown): v is JournalSource =>
  typeof v === "string" && (JOURNAL_SOURCES as readonly string[]).includes(v);

/** The ages the journal can keep, in days (mirror of `journal::RETENTION_DAYS`). */
export const JOURNAL_DAYS = [1, 7, 30, 90] as const;

export const DEFAULT_JOURNAL_DAYS = 30;

/** No more entries than this are kept (mirror of `journal::MAX_ENTRIES`). */
export const JOURNAL_MAX_ENTRIES = 1000;

/** A stored age as the journal takes it: one of the four, the default otherwise. */
export function sanitizeJournalDays(v: unknown): number {
  return (JOURNAL_DAYS as readonly unknown[]).includes(v) ? (v as number) : DEFAULT_JOURNAL_DAYS;
}

/** No more toasts than this stand in a window; the rest wait under one line. */
export const MAX_TOASTS = 3;

/** The tab a message was about, as far as the journal asks. */
export interface TabRef {
  kind: "ssh" | "local";
  serverId: string;
  alias: string;
}

/** The server a message names: an SSH tab's server, a local tab by its title. */
export function serverOf(tab: TabRef | null): { serverId?: string; server?: string } {
  if (!tab) return {};
  const server = tab.alias.trim() || undefined;
  return tab.kind === "ssh" && tab.serverId ? { serverId: tab.serverId, server } : { server };
}

/**
 * What makes two toasts one: the same words in the same tone, from the same
 * part of the app about the same server. Said again, a toast counts up and
 * stays, instead of a second one standing under it.
 */
export function toastKey(kind: JournalKind, message: string, source = "", serverId = ""): string {
  return JSON.stringify([kind, message, source, serverId]);
}

/** Which toasts a window draws — the newest `max` — and how many wait unseen. */
export function fitToasts<T>(list: readonly T[], max = MAX_TOASTS): { shown: T[]; hidden: number } {
  const hidden = Math.max(0, list.length - max);
  return { shown: list.slice(hidden), hidden };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local day of `ms`, as a key that sorts: `2026-11-11`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How a day's group is named: today, yesterday, or by its date. */
export function dayKind(key: string, now: number): "today" | "yesterday" | "date" {
  if (key === dayKey(now)) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return key === dayKey(yesterday.getTime()) ? "yesterday" : "date";
}

/** The local time of `ms` as a row shows it: `14:32:05`. */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The window a row names: none when it was said in the window that reads it
 * (or nobody knows where), else `main` or the number of the window.
 */
export function windowOf(label: string | null, here: string): "main" | number | null {
  if (!label || label === here) return null;
  if (label === "main") return "main";
  const n = /^win-(\d+)$/.exec(label);
  return n ? Number(n[1]) : null;
}

/** The kinds in the order the facet lists them: what needs attention first. */
const KIND_ORDER: readonly JournalKind[] = ["error", "info", "success"];

/** The journal as a list: newest first, by day, narrowed by tone, server and source. */
export const JOURNAL_SCHEMA: ListSchema<JournalEntry> = {
  text: (e) => [e.text, e.server ?? "", e.source ?? ""].join(" "),
  sorts: [{ id: "time", firstDir: "desc", compare: (a, b) => a.last - b.last }],
  groups: [
    {
      id: "day",
      of: (e) => ({ key: dayKey(e.last), label: dayKey(e.last) }),
      // Newest day first; keys are dates that sort as text.
      compare: (a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0),
    },
  ],
  facets: [
    { id: "kind", value: (e) => e.kind, order: KIND_ORDER },
    { id: "server", value: (e) => e.server ?? "" },
    { id: "source", value: (e) => e.source ?? "" },
  ],
  tie: (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
};

/** How the journal always lies: by day, newest first. */
export const JOURNAL_ORDER = { sort: { key: "time", dir: "desc" as const }, group: "day" };

/**
 * The entries as text for the clipboard (a bug report, a message to a
 * colleague): one line each, the date and time, the tone, where it came from,
 * how many times — and the message, its lines kept under it.
 */
export function journalText(
  entries: readonly JournalEntry[],
  name: { kind: (k: JournalKind) => string; source: (s: string) => string },
): string {
  return entries
    .map((e) => {
      const where = [e.server, e.source ? name.source(e.source) : null].filter(Boolean).join(" · ");
      const head = [
        `${dayKey(e.last)} ${clockOf(e.last)}`,
        name.kind(e.kind),
        where,
        e.count > 1 ? `×${e.count}` : "",
      ].filter(Boolean);
      return `${head.join("  ")}\n  ${e.text.replace(/\n/g, "\n  ")}`;
    })
    .join("\n");
}
