import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../types";
import { applyView, NO_FILTER, pickFacet, facetValues } from "../ui/listview";
import {
  clockOf,
  dayKey,
  dayKind,
  DEFAULT_JOURNAL_DAYS,
  fitToasts,
  isJournalSource,
  JOURNAL_DAYS,
  JOURNAL_ORDER,
  JOURNAL_SCHEMA,
  JOURNAL_SOURCES,
  journalText,
  MAX_TOASTS,
  sanitizeJournalDays,
  serverOf,
  toastKey,
  windowOf,
} from "./journal";

const at = (y: number, m: number, d: number, h = 12, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s).getTime();

function entry(over: Partial<JournalEntry>): JournalEntry {
  return {
    id: "e",
    kind: "info",
    text: "message",
    source: null,
    serverId: null,
    server: null,
    window: "main",
    first: at(2026, 11, 11),
    last: at(2026, 11, 11),
    count: 1,
    read: false,
    ...over,
  };
}

describe("what a message is about", () => {
  it("names the server of an SSH tab with its id, a local tab by its title", () => {
    expect(serverOf({ kind: "ssh", serverId: "srv-1", alias: "prod-db" })).toEqual({ serverId: "srv-1", server: "prod-db" });
    expect(serverOf({ kind: "local", serverId: "", alias: "zsh" })).toEqual({ server: "zsh" });
    expect(serverOf({ kind: "ssh", serverId: "srv-1", alias: "  " })).toEqual({ serverId: "srv-1", server: undefined });
    expect(serverOf(null)).toEqual({});
  });

  it("knows its sources, each once", () => {
    expect(new Set(JOURNAL_SOURCES).size).toBe(JOURNAL_SOURCES.length);
    expect(isJournalSource("docker")).toBe(true);
    expect(isJournalSource("Docker")).toBe(false);
    expect(isJournalSource(3)).toBe(false);
  });

  it("keeps one of the offered ages", () => {
    for (const d of JOURNAL_DAYS) expect(sanitizeJournalDays(d)).toBe(d);
    for (const v of [undefined, 0, 5, "30", null, 365]) expect(sanitizeJournalDays(v)).toBe(DEFAULT_JOURNAL_DAYS);
    expect(JOURNAL_DAYS).toContain(DEFAULT_JOURNAL_DAYS);
  });
});

describe("toasts", () => {
  it("are the same toast by tone, words, source and server", () => {
    expect(toastKey("error", "x", "docker", "s1")).toBe(toastKey("error", "x", "docker", "s1"));
    for (const other of [
      toastKey("info", "x", "docker", "s1"),
      toastKey("error", "y", "docker", "s1"),
      toastKey("error", "x", "k8s", "s1"),
      toastKey("error", "x", "docker", "s2"),
    ]) {
      expect(other).not.toBe(toastKey("error", "x", "docker", "s1"));
    }
    // Words that run into each other are not mistaken for one another.
    expect(toastKey("error", "a|b", "", "")).not.toBe(toastKey("error", "a", "b", ""));
  });

  it("stand no more than MAX_TOASTS at once, the newest", () => {
    expect(fitToasts([1, 2])).toEqual({ shown: [1, 2], hidden: 0 });
    const many = Array.from({ length: MAX_TOASTS + 3 }, (_, i) => i);
    expect(fitToasts(many)).toEqual({ shown: many.slice(3), hidden: 3 });
    expect(fitToasts([], 2)).toEqual({ shown: [], hidden: 0 });
  });
});

describe("days and times", () => {
  it("a day is a local date that sorts as text", () => {
    expect(dayKey(at(2026, 1, 2, 0, 0, 1))).toBe("2026-01-02");
    expect(dayKey(at(2026, 11, 11, 23, 59, 59))).toBe("2026-11-11");
    expect(clockOf(at(2026, 11, 11, 4, 5, 6))).toBe("04:05:06");
  });

  it("names today and yesterday, and dates the rest — across a month's end", () => {
    const now = at(2026, 12, 1, 9);
    expect(dayKind("2026-12-01", now)).toBe("today");
    expect(dayKind("2026-11-30", now)).toBe("yesterday");
    expect(dayKind("2026-11-29", now)).toBe("date");
  });

  it("names the window only when it is another one", () => {
    expect(windowOf("main", "main")).toBeNull();
    expect(windowOf(null, "main")).toBeNull();
    expect(windowOf("main", "win-2")).toBe("main");
    expect(windowOf("win-3", "main")).toBe(3);
    expect(windowOf("drag-ghost", "main")).toBeNull();
  });
});

describe("the journal as a list", () => {
  const list = [
    entry({ id: "a", kind: "error", text: "exec channel failed", server: "prod-db", source: "docker", last: at(2026, 11, 11, 14) }),
    entry({ id: "b", kind: "success", text: "Folder created", server: "stage", source: "files", last: at(2026, 11, 11, 9) }),
    entry({ id: "c", kind: "info", text: "Autorecording", server: "prod-db", source: "recording", last: at(2026, 11, 10, 18) }),
    entry({ id: "d", kind: "error", text: "no server", last: at(2026, 11, 9, 8) }),
  ];

  it("lies by day, newest day and newest entry first", () => {
    const view = applyView(list, JOURNAL_SCHEMA, NO_FILTER, JOURNAL_ORDER);
    expect(view.groups.map((g) => [g.key, g.items.map((e) => e.id)])).toEqual([
      ["2026-11-11", ["a", "b"]],
      ["2026-11-10", ["c"]],
      ["2026-11-09", ["d"]],
    ]);
  });

  it("is narrowed by tone, server and source, and found by its words and its server", () => {
    let f = pickFacet(NO_FILTER, JOURNAL_SCHEMA, "kind", "error");
    expect(applyView(list, JOURNAL_SCHEMA, f, JOURNAL_ORDER).shown).toBe(2);
    f = pickFacet(f, JOURNAL_SCHEMA, "server", "prod-db");
    expect(applyView(list, JOURNAL_SCHEMA, f, JOURNAL_ORDER).groups.flatMap((g) => g.items.map((e) => e.id))).toEqual(["a"]);
    expect(applyView(list, JOURNAL_SCHEMA, { text: "stage", facets: {} }, JOURNAL_ORDER).shown).toBe(1);
    expect(applyView(list, JOURNAL_SCHEMA, { text: "channel", facets: {} }, JOURNAL_ORDER).shown).toBe(1);
    // Errors first in the facet, whatever their count.
    expect(facetValues(list, JOURNAL_SCHEMA, NO_FILTER, "kind").map((v) => v.value)).toEqual(["error", "info", "success"]);
    // An entry with no server is not a value of the server facet.
    expect(facetValues(list, JOURNAL_SCHEMA, NO_FILTER, "server").map((v) => v.value).sort()).toEqual(["prod-db", "stage"]);
  });

  it("copies as lines a person can read and paste", () => {
    const text = journalText([list[0], entry({ id: "z", text: "two\nlines", count: 3 })], {
      kind: (k) => k.toUpperCase(),
      source: (s) => `<${s}>`,
    });
    expect(text).toBe(
      ["2026-11-11 14:00:00  ERROR  prod-db · <docker>", "  exec channel failed", "2026-11-11 12:00:00  INFO  ×3", "  two", "  lines"].join("\n"),
    );
  });
});
