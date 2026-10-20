import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri-backed api used by the Backup section.
const exportBackup = vi.fn();
const importBackup = vi.fn();
const pickBackupSavePath = vi.fn();
const pickBackupFile = vi.fn();
const readBackup = vi.fn();
const listServers = vi.fn();
const listFolders = vi.fn();
vi.mock("./api", () => ({
  exportBackup: (...a: unknown[]) => exportBackup(...a),
  importBackup: (...a: unknown[]) => importBackup(...a),
  pickBackupSavePath: (...a: unknown[]) => pickBackupSavePath(...a),
  pickBackupFile: (...a: unknown[]) => pickBackupFile(...a),
  readBackup: (...a: unknown[]) => readBackup(...a),
  listServers: (...a: unknown[]) => listServers(...a),
  listFolders: (...a: unknown[]) => listFolders(...a),
  // The local-shell picker (Terminal section) queries the host OS and probes pwsh.
  hostOs: () => Promise.resolve("macos"),
  shellExists: () => Promise.resolve(true),
}));

import SettingsPanel from "./SettingsPanel.svelte";
import { settings, resetSettings, activeFontFamily } from "./settings.svelte";
import { DEFAULT_THEME_ID } from "./themes";

beforeEach(() => {
  localStorage.clear();
  settings.language = "en";
  exportBackup.mockReset().mockResolvedValue(undefined);
  importBackup.mockReset();
  pickBackupSavePath.mockReset();
  pickBackupFile.mockReset();
  readBackup.mockReset();
  listServers.mockReset().mockResolvedValue([]);
  listFolders.mockReset().mockResolvedValue([]);
});

const backupServer = (id: string, username: string) => ({
  id,
  alias: id,
  host: `${id}.example.net`,
  port: 22,
  username,
  authMethod: "password",
  keyPath: null,
  hasSavedPassword: true,
  group: null,
  tags: [],
  prod: false,
  autoRecord: false,
  noAi: false,
  chatPromptId: null,
  execMode: null,
  proxy: null,
  notes: "",
  icon: "",
  iconColor: "",
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

  it("shows what the backup holds before writing anything, then imports and notifies the parent", async () => {
    pickBackupFile.mockResolvedValue("/in/vterm.zip");
    readBackup.mockResolvedValue({
      kind: "all",
      servers: [backupServer("a", "boris"), backupServer("b", "root")],
      folders: ["Prod", "Dev"],
      settings: true,
      recordings: 5,
    });
    importBackup.mockResolvedValue({
      kind: "all",
      servers: 2,
      folders: 2,
      recordings: 5,
      settings: { theme: "nord" },
    });
    const onImported = vi.fn();
    render(SettingsPanel, { props: { open: true, onImported } });

    await userEvent.click(screen.getByTestId("backup-import"));
    await screen.findByTestId("backup-logins");
    expect(readBackup).toHaveBeenCalledWith("/in/vterm.zip");
    expect(importBackup).not.toHaveBeenCalled();

    // The backup was made by someone else: their login becomes ours.
    await userEvent.type(screen.getByLabelText("Replace boris with"), "ivan");
    await userEvent.click(screen.getByTestId("backup-import-confirm"));

    await waitFor(() => expect(importBackup).toHaveBeenCalledOnce());
    const [path, catalog, recordings] = importBackup.mock.calls[0];
    expect(path).toBe("/in/vterm.zip");
    expect(recordings).toBe(true);
    expect(catalog.servers.map((s: { username: string }) => s.username)).toEqual(["ivan", "root"]);
    // No secret here for these servers: the hint does not claim one.
    expect(catalog.servers.every((s: { hasSavedPassword: boolean }) => !s.hasSavedPassword)).toBe(true);
    expect(catalog.folders).toEqual(["Prod", "Dev"].sort());
    expect(onImported).toHaveBeenCalledOnce();
    const msg = await screen.findByTestId("backup-msg");
    expect(msg).toHaveTextContent(/Added 2 server\(s\), skipped 0 already here; 2 folder\(s\)/);
    expect(msg).toHaveTextContent(/Settings applied/);
    expect(msg).toHaveTextContent(/Imported 5 recording\(s\)/);
  });

  it("writes nothing when the preview is cancelled", async () => {
    pickBackupFile.mockResolvedValue("/in/vterm.zip");
    readBackup.mockResolvedValue({ kind: "servers", servers: [backupServer("a", "boris")], folders: [], settings: false, recordings: null });
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("backup-import"));
    await screen.findByTestId("backup-logins");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("backup-logins")).toBeNull());
    expect(importBackup).not.toHaveBeenCalled();
  });

  it("reports a settings-only import without touching servers", async () => {
    pickBackupFile.mockResolvedValue("/in/settings.zip");
    readBackup.mockResolvedValue({ kind: "settings", servers: null, folders: null, settings: true, recordings: null });
    importBackup.mockResolvedValue({
      kind: "settings",
      servers: null,
      folders: null,
      recordings: null,
      settings: { theme: "nord" },
    });
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("backup-import"));
    await userEvent.click(await screen.findByTestId("backup-import-confirm"));

    await waitFor(() => expect(importBackup).toHaveBeenCalledWith("/in/settings.zip", null, false));
    const msg = await screen.findByTestId("backup-msg");
    expect(msg).toHaveTextContent(/Settings applied/);
    expect(msg).not.toHaveTextContent(/server/i);
  });

  it("a backup that cannot be read is an error, not an empty preview", async () => {
    pickBackupFile.mockResolvedValue("/in/broken.zip");
    readBackup.mockRejectedValue("not a vterm backup (no manifest)");
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("backup-import"));
    const msg = await screen.findByTestId("backup-msg");
    expect(msg).toHaveTextContent(/no manifest/);
    expect(screen.queryByTestId("backup-import-confirm")).toBeNull();
  });
});

describe("SettingsPanel — appearance & search", () => {
  it("keeps a chosen font across retro themes and returns to automatic mode", async () => {
    resetSettings();
    settings.language = "en";
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("settings-group-appearance"));
    await userEvent.click(screen.getByTestId("font-toggle"));
    await userEvent.click(screen.getByTitle("Fira Code"));
    await userEvent.click(screen.getByTestId("theme-toggle"));
    await userEvent.click(screen.getByTitle("Amber CRT"));
    expect(activeFontFamily()).toBe("'Fira Code', monospace");
    await userEvent.click(screen.getByRole("radio", { name: /Follow theme/ }));
    expect(activeFontFamily()).toBe("'Share Tech Mono', monospace");
    await userEvent.click(screen.getByTitle("GitHub Light"));
    expect(activeFontFamily()).toBe("'JetBrains Mono', monospace");
    resetSettings();
  });
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

  it("deep-links to Server tools (the top-bar gear target)", () => {
    const { container } = render(SettingsPanel, {
      props: { open: true, initialSection: "servertools" },
    });
    // Server tools lives in Sessions & monitoring — shown without manual navigation.
    expect(container.querySelector('[data-settings-section="servertools"]')).not.toBeNull();
    expect(screen.getByText("Server tools")).toBeInTheDocument();
  });

  it("re-scrolls the deep-linked section to the top when its content grows", async () => {
    const ResizeObserverMock = globalThis.ResizeObserver as unknown as {
      instances: { cb: ResizeObserverCallback }[];
    };
    ResizeObserverMock.instances.length = 0;
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    render(SettingsPanel, { props: { open: true, initialSection: "servertools" } });

    // First scroll happens after tick + rAF and registers a ResizeObserver.
    await waitFor(() => expect(ResizeObserverMock.instances.length).toBeGreaterThanOrEqual(1));
    expect(scrollSpy).toHaveBeenCalled();
    const before = scrollSpy.mock.calls.length;

    // Simulate the server-tools list loading and growing the section: the
    // observer must re-scroll so the heading lands at the top, not short of it.
    const observer = ResizeObserverMock.instances[ResizeObserverMock.instances.length - 1];
    observer.cb([], {} as ResizeObserver);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(before);
    scrollSpy.mockRestore();
  });

  it("shows no group-name header while browsing (the sidebar tab already names it)", async () => {
    render(SettingsPanel, { props: { open: true } });
    // Browsing a group: no header (it would duplicate the active tab).
    expect(screen.queryByTestId("settings-active-header")).toBeNull();
    await userEvent.click(screen.getByTestId("settings-group-terminal"));
    expect(screen.queryByTestId("settings-active-header")).toBeNull();
    // Searching spans groups, so a "Search results" header labels the matches.
    await userEvent.type(screen.getByTestId("settings-search"), "security");
    expect(screen.getByTestId("settings-active-header")).toHaveTextContent("Search results");
  });

  it("moves between groups with arrow keys", async () => {
    render(SettingsPanel, { props: { open: true } });
    screen.getByTestId("settings-group-general").focus();
    await userEvent.keyboard("{ArrowDown}");
    // Group change is reflected on the sidebar tab (aria-current), not a header.
    expect(screen.getByTestId("settings-group-appearance")).toHaveAttribute("aria-current", "page");
  });

  it("reset-to-defaults asks for confirmation before wiping settings", async () => {
    render(SettingsPanel, { props: { open: true } });
    // Change a setting away from its default so we can see the reset take effect.
    settings.theme = "nord";

    // Clicking the footer button only opens the confirmation dialog — nothing reset yet.
    await userEvent.click(screen.getByTestId("settings-reset"));
    expect(screen.getByText("Reset all settings?")).toBeInTheDocument();
    expect(settings.theme).toBe("nord");

    // Cancelling leaves settings untouched and closes the dialog.
    await userEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Reset all settings?")).toBeNull();
    expect(settings.theme).toBe("nord");

    // Confirming actually resets to defaults.
    await userEvent.click(screen.getByTestId("settings-reset"));
    await userEvent.click(screen.getByTestId("confirm"));
    expect(settings.theme).toBe(DEFAULT_THEME_ID);
    expect(screen.queryByText("Reset all settings?")).toBeNull();
  });

  it("AI assistant (Phase 17): off by default, can add an endpoint", async () => {
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("settings-group-assistant"));
    const toggle = screen.getByTestId("ai-enabled") as HTMLInputElement;
    expect(toggle.checked).toBe(false); // opt-in
    expect(screen.queryByTestId("ai-endpoint")).toBeNull();
    // The add button opens the preset menu (Phase 40); picking one adds the endpoint.
    await userEvent.click(screen.getByTestId("ai-add-endpoint"));
    await userEvent.click(screen.getByText("Ollama"));
    expect(screen.getAllByTestId("ai-endpoint").length).toBeGreaterThanOrEqual(1);
  });

  it("closes via the header × button", async () => {
    render(SettingsPanel, { props: { open: true } });
    expect(screen.getByText("Settings")).toBeInTheDocument();
    // The header × (aria-label "Close") — the backdrop no longer closes anything.
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Settings")).toBeNull();
  });
});
