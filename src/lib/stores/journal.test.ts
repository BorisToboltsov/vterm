import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalEntry, JournalSummary } from "../types";

const backend = vi.hoisted(() => ({
  entries: [] as JournalEntry[],
  summary: { rev: 0, total: 0, unreadErrors: false } as JournalSummary,
  heard: null as null | ((e: { payload: JournalSummary }) => void),
  calls: [] as string[],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, cb: (e: { payload: JournalSummary }) => void) => {
    backend.heard = cb;
    return () => (backend.heard = null);
  },
}));

function bump(over: Partial<JournalSummary> = {}): JournalSummary {
  backend.summary = {
    rev: backend.summary.rev + 1,
    total: backend.entries.length,
    unreadErrors: backend.entries.some((e) => !e.read && e.kind === "error"),
    ...over,
  };
  return backend.summary;
}

vi.mock("../api/journal", () => ({
  JOURNAL_EVENT: "window://journal",
  journalSummary: async () => backend.summary,
  journalList: async () => {
    backend.calls.push("list");
    return backend.entries.map((e) => ({ ...e }));
  },
  journalNote: async (note: { kind: JournalEntry["kind"]; text: string }) => {
    backend.calls.push("note");
    backend.entries.unshift(entry({ id: `n${backend.entries.length}`, kind: note.kind, text: note.text }));
    return bump();
  },
  journalMarkRead: async () => {
    backend.calls.push("read");
    for (const e of backend.entries) e.read = true;
    return bump();
  },
  journalRemove: async (ids: string[]) => {
    backend.entries = backend.entries.filter((e) => !ids.includes(e.id));
    return bump();
  },
  journalClear: async () => {
    backend.entries = [];
    return bump();
  },
  journalConfigure: async (persist: boolean, days: number) => {
    backend.calls.push(`configure:${persist}:${days}`);
    return backend.summary;
  },
}));

import {
  clearJournal,
  closeJournal,
  configureJournal,
  journalState,
  noteJournal,
  openJournal,
  removeFromJournal,
  startJournal,
  toggleJournal,
  watchJournal,
} from "./journal.svelte";

function entry(over: Partial<JournalEntry>): JournalEntry {
  return {
    id: "e",
    kind: "info",
    text: "x",
    source: null,
    serverId: null,
    server: null,
    window: "main",
    first: 1,
    last: 1,
    count: 1,
    read: false,
    ...over,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the journal in this window", () => {
  let stop: () => void;
  let unwatch: (() => void) | null = null;
  beforeEach(async () => {
    backend.entries = [entry({ id: "old", kind: "error", read: true }), entry({ id: "new", kind: "error" })];
    backend.summary = { rev: 7, total: 2, unreadErrors: true };
    backend.calls = [];
    stop = startJournal();
    await settle();
  });
  afterEach(() => {
    unwatch?.();
    unwatch = null;
    closeJournal();
    stop();
  });

  it("knows the bell's answer before anything is opened, without reading the list", () => {
    expect(journalState.summary).toEqual({ rev: 7, total: 2, unreadErrors: true });
    expect(backend.calls).not.toContain("list");
  });

  it("a view that shows the list reads it, keeps what was unread marked, and marks it seen", async () => {
    unwatch = watchJournal();
    await settle();
    await settle();
    expect(journalState.fresh).toEqual(["new"]);
    expect(journalState.summary.unreadErrors).toBe(false);
    expect(journalState.entries.every((e) => e.read)).toBe(true);
    // A second view (the popover over the open Settings) reads, but marks nothing again.
    const reads = backend.calls.filter((c) => c === "read").length;
    const second = watchJournal();
    await settle();
    expect(backend.calls.filter((c) => c === "read").length).toBe(reads);
    second();
    expect(journalState.fresh).toEqual(["new"]);
    // The last view gone, nothing stays marked.
    unwatch();
    unwatch = null;
    expect(journalState.fresh).toEqual([]);
  });

  it("a shown list reads itself again when another window changed the journal", async () => {
    unwatch = watchJournal();
    await settle();
    await settle();
    backend.entries.unshift(entry({ id: "elsewhere", kind: "info" }));
    backend.heard?.({ payload: bump() });
    await settle();
    expect(journalState.entries.map((e) => e.id)).toContain("elsewhere");
  });

  it("a closed journal hears the change but does not read the list", async () => {
    backend.heard?.({ payload: bump({ unreadErrors: true }) });
    await settle();
    expect(journalState.summary.rev).toBe(8);
    expect(backend.calls).not.toContain("list");
  });

  it("noting never throws and the summary follows", async () => {
    noteJournal({ kind: "error", text: "boom" });
    await settle();
    expect(backend.calls).toContain("note");
    expect(journalState.summary.total).toBe(3);
  });

  it("opens and closes the popover; removes and clears for every window", async () => {
    openJournal();
    expect(journalState.open).toBe(true);
    toggleJournal();
    expect(journalState.open).toBe(false);
    toggleJournal();
    expect(journalState.open).toBe(true);
    closeJournal();
    expect(journalState.open).toBe(false);
    unwatch = watchJournal();
    await settle();
    await settle();
    await removeFromJournal(["old"]);
    await settle();
    expect(journalState.entries.map((e) => e.id)).toEqual(["new"]);
    await removeFromJournal([]);
    await clearJournal();
    await settle();
    expect(journalState.entries).toEqual([]);
    expect(journalState.summary.total).toBe(0);
  });

  it("tells the backend what the settings say", async () => {
    configureJournal(false, 7);
    await settle();
    expect(backend.calls).toContain("configure:false:7");
  });
});
