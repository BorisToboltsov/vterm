import { fireEvent, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalEntry } from "../types";

const removed = vi.hoisted(() => ({ ids: [] as string[][], cleared: 0, entries: [] as unknown[] }));
vi.mock("../api/journal", () => ({
  JOURNAL_EVENT: "window://journal",
  journalSummary: async () => ({ rev: 0, total: 0, unreadErrors: false }),
  journalList: async () => removed.entries,
  journalNote: async () => ({ rev: 0, total: 0, unreadErrors: false }),
  journalMarkRead: async () => ({ rev: 0, total: 0, unreadErrors: false }),
  journalRemove: async (ids: string[]) => {
    removed.ids.push(ids);
    return { rev: 1, total: 0, unreadErrors: false };
  },
  journalClear: async () => {
    removed.cleared++;
    return { rev: 1, total: 0, unreadErrors: false };
  },
  journalConfigure: async () => ({ rev: 0, total: 0, unreadErrors: false }),
}));

import JournalPanel from "./JournalPanel.svelte";
import { journalState } from "../stores/journal.svelte";
import { NO_FILTER } from "../ui/listview";
import { settings } from "../settings/settings.svelte";

const now = Date.now();
function entry(over: Partial<JournalEntry>): JournalEntry {
  return {
    id: "e",
    kind: "info",
    text: "x",
    source: null,
    serverId: null,
    server: null,
    window: "main",
    first: now,
    last: now,
    count: 1,
    read: true,
    ...over,
  };
}

function show(entries: JournalEntry[], fresh: string[] = []) {
  // What the backend answers when the list asks for itself on mount.
  removed.entries = entries;
  journalState.entries = entries;
  journalState.fresh = fresh;
  journalState.filter = NO_FILTER;
  journalState.open = true;
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const onsettings = vi.fn();
  render(JournalPanel, { props: { anchor, here: "main", onsettings } });
  return { anchor, onsettings };
}

describe("JournalPanel", () => {
  beforeEach(() => {
    removed.ids = [];
    removed.cleared = 0;
    settings.journalKeep = true;
    settings.journalDays = 30;
  });
  afterEach(() => {
    journalState.open = false;
    document.body.innerHTML = "";
  });

  it("an empty journal says what it is for", () => {
    show([]);
    expect(screen.getByTestId("journal-empty")).toHaveTextContent("No messages yet");
    expect(screen.queryByTestId("journal-copy")).toBeNull();
  });

  it("lists the entries by day, counted, with their server, source and another window", () => {
    show(
      [
        entry({ id: "a", kind: "error", text: "exec channel failed", server: "prod-db", source: "docker", count: 14, window: "win-2", read: false }),
        entry({ id: "b", kind: "success", text: "Folder created", server: "stage", source: "files" }),
        entry({ id: "c", text: "yesterday's", last: now - 86_400_000, first: now - 86_400_000 }),
      ],
      ["a"],
    );
    const days = screen.getAllByTestId("journal-day");
    expect(days.map((d) => d.textContent)).toEqual([expect.stringContaining("Today"), expect.stringContaining("Yesterday")]);
    const rows = screen.getAllByTestId("journal-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("exec channel failed");
    expect(rows[0]).toHaveTextContent("prod-db · Docker · window 2");
    expect(within(rows[0]).getByTestId("journal-count")).toHaveTextContent("×14");
    expect(rows[1]).toHaveTextContent("stage · Files");
    expect(rows[1]).not.toHaveTextContent("window");
    expect(screen.getByTestId("journal-kept")).toHaveTextContent("Kept for 30 d · entries: 3");
  });

  it("is narrowed by the filter row", async () => {
    show([
      entry({ id: "a", kind: "error", text: "boom", server: "prod-db" }),
      entry({ id: "b", kind: "info", text: "fyi", server: "stage" }),
    ]);
    await userEvent.type(screen.getByTestId("journal-header-field"), "stage");
    expect(screen.getAllByTestId("journal-row")).toHaveLength(1);
    expect(screen.getByTestId("journal-row")).toHaveTextContent("fyi");
  });

  it("a long journal draws a page and the rest on request", async () => {
    show(Array.from({ length: 250 }, (_, i) => entry({ id: `e${i}`, text: `m${i}`, last: now - i })));
    expect(screen.getAllByTestId("journal-row")).toHaveLength(200);
    await userEvent.click(screen.getByTestId("journal-more"));
    expect(screen.getAllByTestId("journal-row")).toHaveLength(250);
  });

  it("Esc and a press elsewhere put it away; a press inside or on the bell does not", async () => {
    const { anchor } = show([entry({ id: "a" })]);
    await fireEvent.pointerDown(screen.getByTestId("journal-list"));
    await fireEvent.pointerDown(anchor);
    expect(journalState.open).toBe(true);
    await fireEvent.pointerDown(document.body);
    expect(journalState.open).toBe(false);
    journalState.open = true;
    await fireEvent.keyDown(screen.getByTestId("journal-panel"), { key: "Escape" });
    expect(journalState.open).toBe(false);
  });

  it("clears what was read — asked first", async () => {
    show([entry({ id: "seen" }), entry({ id: "fresh", read: false })], ["fresh"]);
    await userEvent.click(screen.getByTestId("journal-menu"));
    await userEvent.click(screen.getByRole("menuitem", { name: /Clear read/ }));
    // The question is up; nothing is removed yet, and the panel stays.
    expect(removed.ids).toEqual([]);
    expect(screen.getByText(/Entries: 1\./)).toBeInTheDocument();
    await fireEvent.pointerDown(document.body);
    expect(journalState.open).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(removed.ids).toEqual([["seen"]]);
  });

  it("clears what the filter shows, or everything", async () => {
    show([entry({ id: "a", kind: "error", text: "boom" }), entry({ id: "b", text: "fyi" })]);
    journalState.filter = { text: "boom", facets: {} };
    await userEvent.click(await screen.findByTestId("journal-menu"));
    await userEvent.click(screen.getByRole("menuitem", { name: /Clear shown/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(removed.ids).toEqual([["a"]]);
    await userEvent.click(screen.getByTestId("journal-menu"));
    await userEvent.click(screen.getByRole("menuitem", { name: /Clear the whole journal/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(removed.cleared).toBe(1);
  });

  it("its settings are a button of its header", async () => {
    const { onsettings } = show([entry({ id: "a" })]);
    await userEvent.click(screen.getByTestId("journal-settings"));
    expect(onsettings).toHaveBeenCalledOnce();
  });
});
