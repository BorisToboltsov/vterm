import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri-backed api used by the Backup section.
const exportBackup = vi.fn();
const importBackup = vi.fn();
const pickBackupSavePath = vi.fn();
const pickBackupFile = vi.fn();
vi.mock("./api", () => ({
  exportBackup: (...a: unknown[]) => exportBackup(...a),
  importBackup: (...a: unknown[]) => importBackup(...a),
  pickBackupSavePath: (...a: unknown[]) => pickBackupSavePath(...a),
  pickBackupFile: (...a: unknown[]) => pickBackupFile(...a),
}));

import SettingsPanel from "./SettingsPanel.svelte";
import { settings } from "./settings.svelte";

beforeEach(() => {
  localStorage.clear();
  settings.language = "en";
  exportBackup.mockReset().mockResolvedValue(undefined);
  importBackup.mockReset();
  pickBackupSavePath.mockReset();
  pickBackupFile.mockReset();
});

describe("SettingsPanel — backup", () => {
  it("exports to the chosen path with the selected kind and current settings", async () => {
    pickBackupSavePath.mockResolvedValue("/out/vterm.zip");
    render(SettingsPanel, { props: { open: true } });

    await userEvent.click(screen.getByTestId("backup-export"));

    await waitFor(() => expect(exportBackup).toHaveBeenCalledOnce());
    const [path, kind, settings] = exportBackup.mock.calls[0];
    expect(path).toBe("/out/vterm.zip");
    expect(kind).toBe("all"); // default preset
    expect(settings).toHaveProperty("theme"); // a settings snapshot was passed
    expect(await screen.findByTestId("backup-msg")).toHaveTextContent(/exported/i);
  });

  it("exports only the chosen section when a kind is selected", async () => {
    pickBackupSavePath.mockResolvedValue("/out/vterm.zip");
    render(SettingsPanel, { props: { open: true } });

    await userEvent.selectOptions(screen.getByTestId("backup-kind"), "recordings");
    await userEvent.click(screen.getByTestId("backup-export"));

    await waitFor(() => expect(exportBackup).toHaveBeenCalledOnce());
    expect(exportBackup.mock.calls[0][1]).toBe("recordings");
  });

  it("does nothing when export is cancelled", async () => {
    pickBackupSavePath.mockResolvedValue(null);
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("backup-export"));
    await waitFor(() => expect(pickBackupSavePath).toHaveBeenCalled());
    expect(exportBackup).not.toHaveBeenCalled();
  });

  it("imports after confirmation and notifies the parent", async () => {
    pickBackupFile.mockResolvedValue("/in/vterm.zip");
    importBackup.mockResolvedValue({
      kind: "all",
      servers: 3,
      folders: 2,
      recordings: 5,
      settings: { theme: "nord" },
    });
    const onImported = vi.fn();
    render(SettingsPanel, { props: { open: true, onImported } });

    // First click opens the confirmation dialog (destructive replace).
    await userEvent.click(screen.getByTestId("backup-import"));
    expect(importBackup).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByTestId("confirm"));

    await waitFor(() => expect(importBackup).toHaveBeenCalledWith("/in/vterm.zip"));
    expect(onImported).toHaveBeenCalledOnce();
    const msg = await screen.findByTestId("backup-msg");
    expect(msg).toHaveTextContent(/Restored 3 server\(s\), 2 folder\(s\)/);
    expect(msg).toHaveTextContent(/Imported 5 recording\(s\)/);
  });

  it("reports a settings-only import without touching servers", async () => {
    pickBackupFile.mockResolvedValue("/in/settings.zip");
    importBackup.mockResolvedValue({
      kind: "settings",
      servers: null,
      folders: null,
      recordings: null,
      settings: { theme: "nord" },
    });
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("backup-import"));
    await userEvent.click(await screen.findByTestId("confirm"));

    await waitFor(() => expect(importBackup).toHaveBeenCalled());
    const msg = await screen.findByTestId("backup-msg");
    expect(msg).toHaveTextContent(/Settings applied/);
    expect(msg).not.toHaveTextContent(/server/i);
  });
});

describe("SettingsPanel — appearance & search", () => {
  it("theme picker is collapsed by default and expands on click", async () => {
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("settings-group-appearance"));
    // Collapsed: no theme options rendered yet.
    expect(screen.queryByTitle("GitHub Light")).toBeNull();
    await userEvent.click(screen.getByTestId("theme-toggle"));
    expect(screen.getByTitle("GitHub Light")).toBeInTheDocument();
  });

  it("selects a theme from the visual picker", async () => {
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("settings-group-appearance"));
    await userEvent.click(screen.getByTestId("theme-toggle"));
    const gh = screen.getByTitle("GitHub Light");
    expect(gh).toHaveAttribute("aria-checked", "false");
    await userEvent.click(gh);
    expect(screen.getByTitle("GitHub Light")).toHaveAttribute("aria-checked", "true");
  });

  it("font picker is collapsed by default and reveals a live preview", async () => {
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("settings-group-appearance"));
    expect(screen.queryByTestId("font-preview")).toBeNull();
    await userEvent.click(screen.getByTestId("font-toggle"));
    const preview = screen.getByTestId("font-preview");
    expect(preview).toBeInTheDocument();
    expect(preview.textContent).toContain("def greet");
  });

  it("selects a font from the grid", async () => {
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("settings-group-appearance"));
    await userEvent.click(screen.getByTestId("font-toggle"));
    const jb = screen.getByTitle("JetBrains Mono");
    expect(jb).toHaveAttribute("aria-checked", "false");
    await userEvent.click(jb);
    expect(screen.getByTitle("JetBrains Mono")).toHaveAttribute("aria-checked", "true");
  });

  it("filters sections across groups by search query", async () => {
    render(SettingsPanel, { props: { open: true } });
    // Default group (General) shows Backup; Security lives in another group.
    expect(screen.getByText("Backup")).toBeInTheDocument();
    expect(screen.queryByText("Security")).toBeNull();

    // Searching matches across all groups, ignoring the active group.
    await userEvent.type(screen.getByTestId("settings-search"), "security");
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.queryByText("Backup")).toBeNull();
  });

  it("navigates groups via the sidebar", async () => {
    render(SettingsPanel, { props: { open: true } });
    // Terminal section is not in the default General group.
    expect(screen.queryByTestId("metrics-toggle")).toBeNull();
    await userEvent.click(screen.getByTestId("settings-group-sessions"));
    // Status-bar (in Sessions & monitoring) is now visible.
    expect(screen.getByTestId("metrics-toggle")).toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", async () => {
    render(SettingsPanel, { props: { open: true } });
    await userEvent.type(screen.getByTestId("settings-search"), "zzzzz");
    expect(screen.getByText("Nothing found")).toBeInTheDocument();
  });

  it("switches the UI language live via the language select", async () => {
    render(SettingsPanel, { props: { open: true } });
    // English by default.
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId("language-select"), "ru");
    // The heading (and the rest of the panel) re-renders in Russian.
    expect(screen.getByRole("heading", { name: "Настройки" })).toBeInTheDocument();
    expect(settings.language).toBe("ru");
  });

  it("status-bar metric checkboxes are collapsible", async () => {
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("settings-group-sessions"));
    expect(screen.queryByLabelText("CPU")).toBeNull();
    await userEvent.click(screen.getByTestId("metrics-toggle"));
    expect(screen.getByLabelText("CPU")).toBeInTheDocument();
    expect(screen.getByLabelText("Disk")).toBeInTheDocument();
  });

  it("templates (snippets) are collapsed under a disclosure", async () => {
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("settings-group-files"));
    // Collapsed by default: language filter (inside the disclosure) is hidden.
    expect(screen.queryByTestId("snippet-lang-filter")).toBeNull();
    await userEvent.click(screen.getByTestId("snippets-toggle"));
    expect(screen.getByTestId("snippet-lang-filter")).toBeInTheDocument();
  });

  it("deep-links to a section's group via initialSection", () => {
    render(SettingsPanel, { props: { open: true, initialSection: "statusbar" } });
    // statusbar lives in Sessions & monitoring — shown without manual navigation.
    expect(screen.getByTestId("metrics-toggle")).toBeInTheDocument();
  });

  it("reflects the active group in the sticky header", async () => {
    render(SettingsPanel, { props: { open: true } });
    expect(screen.getByTestId("settings-active-header")).toHaveTextContent("General");
    await userEvent.click(screen.getByTestId("settings-group-terminal"));
    expect(screen.getByTestId("settings-active-header")).toHaveTextContent("Terminal");
  });

  it("moves between groups with arrow keys", async () => {
    render(SettingsPanel, { props: { open: true } });
    screen.getByTestId("settings-group-general").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByTestId("settings-active-header")).toHaveTextContent("Appearance");
  });
});
