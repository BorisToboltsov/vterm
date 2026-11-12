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

const diag = vi.hoisted(() => ({
  level: "info",
  levels: [] as string[],
  cleared: 0,
  revealed: 0,
  exported: [] as string[],
  bytes: 2048,
  sizeMb: 25,
  sizes: [] as number[],
}));
const diagStateOf = () => ({
  level: diag.level,
  sizeMb: diag.sizeMb,
  panics: 0,
  bytes: diag.bytes,
  error: null,
  folder: "/data/diag",
});
vi.mock("../api/diag", () => ({
  DIAG_EVENT: "window://diag",
  diag: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  diagState: async () => diagStateOf(),
  diagSetLevel: async (level: string) => {
    diag.levels.push(level);
    diag.level = level;
    return diagStateOf();
  },
  diagQuery: async () => ({
    events: [
      { at: Date.now(), level: "warn", source: "docker", server: "prod-db", text: "poll failed: exec channel failed", count: 4 },
      { at: Date.now() - 1, level: "error", source: "connection", text: "login failed", shown: true, fields: { method: "password" } },
      {
        at: Date.now() - 2,
        level: "info",
        source: "settings",
        text: "diagnostics threshold changed: info -> warn (only warnings and errors are written from now on)",
        code: "threshold",
        fields: { from: "info", to: "warn" },
      },
    ],
    more: true,
    counts: { level: { warn: 1, error: 1 }, source: { docker: 1, connection: 1 }, server: { "prod-db": 1 } },
    total: 40,
    unreadable: 0,
  }),
  diagSetSize: async (sizeMb: number) => {
    diag.sizes.push(sizeMb);
    diag.sizeMb = sizeMb;
    return diagStateOf();
  },
  diagClear: async () => {
    diag.cleared++;
    diag.bytes = 0;
    return diagStateOf();
  },
  diagReveal: async () => void diag.revealed++,
  pickDiagExportPath: async () => "/home/me/vterm.jsonl",
  diagExport: async (path: string) => void diag.exported.push(path),
  flushDiag: () => {},
  setDiagThreshold: () => {},
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

  it("shows the diagnostics as a second layer: what is written, the events, and the way to change, export and clear it", async () => {
    diag.level = "info";
    diag.bytes = 2048;
    diag.levels = [];
    diag.cleared = 0;
    render(JournalSettings, { props: { here: "main" } });
    await userEvent.click(screen.getByRole("radio", { name: "Diagnostics" }));
    await settle();
    await settle();
    expect(screen.queryByTestId("settings-journal-list")).toBeNull();
    const rows = await screen.findAllByTestId("settings-diag-list-row");
    expect(rows[0]).toHaveTextContent("poll failed: exec channel failed");
    expect(rows[0]).toHaveTextContent("prod-db · Docker");
    expect(screen.getByTestId("settings-diag-list-count")).toHaveTextContent("×4");
    expect(screen.getByTestId("settings-diag-list-shown")).toBeInTheDocument();
    expect(screen.getByTestId("settings-diag-list-more")).toBeInTheDocument();
    expect(screen.getByTestId("settings-diag-list-count-line")).toHaveTextContent("Shown: 3 of 40");
    // A known kind is titled in the reader's language, its text under the title.
    expect(screen.getByTestId("settings-diag-list-title")).toHaveTextContent(
      "Diagnostics threshold changed: Information → Warnings",
    );
    expect(rows[2]).toHaveTextContent("diagnostics threshold changed: info -> warn");
    // What is written is said above the list and under the choice.
    expect(screen.getByTestId("settings-diag-list-writes")).toHaveTextContent("Information, warnings and errors are written.");
    expect(screen.getByTestId("diag-size")).toHaveTextContent("On disk: 2 KB of 25 MB");

    await userEvent.selectOptions(screen.getByTestId("diag-threshold"), "warn");
    await settle();
    expect(diag.levels).toEqual(["warn"]);
    expect(screen.getByTestId("diag-threshold-says")).toHaveTextContent("Warnings and errors are written.");

    // How much is kept is the user's too: the line under it says the new size.
    expect(screen.getByTestId<HTMLSelectElement>("diag-size-limit").value).toBe("25");
    await userEvent.selectOptions(screen.getByTestId("diag-size-limit"), "100");
    await settle();
    expect(diag.sizes).toEqual([100]);
    expect(screen.getByTestId("diag-size")).toHaveTextContent("On disk: 2 KB of 100 MB");

    await userEvent.click(screen.getByTestId("diag-export"));
    await settle();
    expect(diag.exported).toEqual(["/home/me/vterm.jsonl"]);
    await userEvent.click(screen.getByTestId("diag-reveal"));
    expect(diag.revealed).toBe(1);

    await userEvent.click(screen.getByTestId("diag-clear"));
    expect(diag.cleared).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await settle();
    expect(diag.cleared).toBe(1);
  });

  it("there is nothing to clear in an empty journal", () => {
    journalState.summary = { rev: 0, total: 0, unreadErrors: false };
    render(JournalSettings, { props: { here: "main" } });
    expect(screen.getByTestId<HTMLButtonElement>("journal-clear").disabled).toBe(true);
  });
});
