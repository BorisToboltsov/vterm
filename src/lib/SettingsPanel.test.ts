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

beforeEach(() => {
  localStorage.clear();
  exportBackup.mockReset().mockResolvedValue(undefined);
  importBackup.mockReset();
  pickBackupSavePath.mockReset();
  pickBackupFile.mockReset();
});

describe("SettingsPanel — backup", () => {
  it("exports to the chosen path with the current settings", async () => {
    pickBackupSavePath.mockResolvedValue("/out/vterm.json");
    render(SettingsPanel, { props: { open: true } });

    await userEvent.click(screen.getByTestId("backup-export"));

    await waitFor(() => expect(exportBackup).toHaveBeenCalledOnce());
    const [path, settings] = exportBackup.mock.calls[0];
    expect(path).toBe("/out/vterm.json");
    expect(settings).toHaveProperty("theme"); // a settings snapshot was passed
    expect(await screen.findByTestId("backup-msg")).toHaveTextContent(/exported/i);
  });

  it("does nothing when export is cancelled", async () => {
    pickBackupSavePath.mockResolvedValue(null);
    render(SettingsPanel, { props: { open: true } });
    await userEvent.click(screen.getByTestId("backup-export"));
    await waitFor(() => expect(pickBackupSavePath).toHaveBeenCalled());
    expect(exportBackup).not.toHaveBeenCalled();
  });

  it("imports after confirmation and notifies the parent", async () => {
    pickBackupFile.mockResolvedValue("/in/vterm.json");
    importBackup.mockResolvedValue({
      serverCount: 3,
      folderCount: 2,
      settings: { theme: "nord" },
    });
    const onImported = vi.fn();
    render(SettingsPanel, { props: { open: true, onImported } });

    // First click opens the confirmation dialog (destructive replace).
    await userEvent.click(screen.getByTestId("backup-import"));
    expect(importBackup).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByTestId("confirm"));

    await waitFor(() => expect(importBackup).toHaveBeenCalledWith("/in/vterm.json"));
    expect(onImported).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("backup-msg")).toHaveTextContent(
      /Restored 3 server\(s\) and 2 folder\(s\)/,
    );
  });
});
