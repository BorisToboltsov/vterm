import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalEntry } from "../types";

const backend = vi.hoisted(() => ({ cleared: 0, entries: [] as JournalEntry[] }));
vi.mock("../api/journal", () => ({
  JOURNAL_EVENT: "window://journal",
  journalSummary: async () => ({ rev: 0, total: 0, unreadErrors: false }),
  journalList: async () => backend.entries,
  journalNote: async () => ({ rev: 0, total: 0, unreadErrors: false }),
  journalMarkRead: async () => ({ rev: 9, total: backend.entries.length, unreadErrors: false }),
  journalRemove: async () => ({ rev: 0, total: 0, unreadErrors: false }),
  journalClear: async () => {
    backend.cleared++;
    return { rev: 1, total: 0, unreadErrors: false };
  },
  journalConfigure: async () => ({ rev: 0, total: 0, unreadErrors: false }),
}));

import JournalSettings from "./JournalSettings.svelte";
import { journalState } from "../stores/journal.svelte";
import { resetSettings, settings } from "../settings/settings.svelte";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Settings → Journal", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettings();
    backend.cleared = 0;
    backend.entries = [];
    journalState.entries = [];
    journalState.summary = { rev: 3, total: 12, unreadErrors: false };
    flushSync();
  });

  it("shows the journal itself — the list its button opens", async () => {
    const now = Date.now();
    backend.entries = [
      { id: "a", kind: "error", text: "exec channel failed", source: "docker", serverId: "s", server: "prod-db", window: "main", first: now, last: now, count: 3, read: false },
    ];
    render(JournalSettings, { props: { here: "main" } });
    await settle();
    expect(await screen.findByTestId("settings-journal-list-row")).toHaveTextContent("exec channel failed");
    expect(screen.getByTestId("settings-journal-list-row")).toHaveTextContent("prod-db · Docker");
    expect(screen.getByTestId("settings-journal-list-count")).toHaveTextContent("×3");
  });

  it("takes the journal's button off the top bar and puts it back with a pin, as a tool of the Utilities window", async () => {
    render(JournalSettings, { props: { here: "main" } });
    const pin = screen.getByTestId("journal-pin");
    expect(settings.topbar).toContain("journal");
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("journal-pin-state")).toHaveTextContent("on the top bar opens it");
    await userEvent.click(pin);
    expect(settings.topbar).not.toContain("journal");
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("journal-pin-state")).toHaveTextContent("stays here and in ⌘K");
    await userEvent.click(pin);
    expect(settings.topbar.slice(-2)).toEqual(["journal", "settings"]);
  });

  it("keeps the journal between launches for 30 days by default; an age is picked only while it is kept", async () => {
    render(JournalSettings, { props: { here: "main" } });
    expect(screen.getByTestId<HTMLInputElement>("journal-keep").checked).toBe(true);
    expect(screen.getByTestId<HTMLSelectElement>("journal-days").value).toBe("30");
    expect(screen.getByTestId("settings-journal")).toHaveTextContent("No more than 1000 entries");
    await userEvent.selectOptions(screen.getByTestId("journal-days"), "7");
    expect(settings.journalDays).toBe(7);
    await userEvent.click(screen.getByTestId("journal-keep"));
    expect(settings.journalKeep).toBe(false);
    expect(screen.getByTestId<HTMLSelectElement>("journal-days").disabled).toBe(true);
  });

  it("clears the journal only after asking, and says how much there is", async () => {
    render(JournalSettings, { props: { here: "main" } });
    expect(screen.getByTestId("settings-journal")).toHaveTextContent("Entries now: 12");
    await userEvent.click(screen.getByTestId("journal-clear"));
    expect(backend.cleared).toBe(0);
    expect(screen.getByText(/Entries: 12\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(backend.cleared).toBe(1);
  });

  it("there is nothing to clear in an empty journal", () => {
    journalState.summary = { rev: 0, total: 0, unreadErrors: false };
    render(JournalSettings, { props: { here: "main" } });
    expect(screen.getByTestId<HTMLButtonElement>("journal-clear").disabled).toBe(true);
  });
});
