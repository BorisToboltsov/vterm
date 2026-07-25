// Server profiles, folder tree, and config backup export/import.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { NewServerProfile, ServerProfile } from "../types";

// ── Server profiles ───────────────────────────────────────────────────────────

export function listServers(): Promise<ServerProfile[]> {
  return invoke<ServerProfile[]>("list_servers");
}

export function addServer(profile: NewServerProfile): Promise<ServerProfile> {
  return invoke<ServerProfile>("add_server", { profile });
}

export function updateServer(
  id: string,
  profile: NewServerProfile,
): Promise<ServerProfile> {
  return invoke<ServerProfile>("update_server", { id, profile });
}

export function deleteServer(id: string): Promise<void> {
  return invoke<void>("delete_server", { id });
}

/** Save a server's free-form notes (Markdown). Dedicated to the notes window so it
 *  never clobbers a concurrent profile edit; returns the updated profile. */
export function setServerNotes(id: string, notes: string): Promise<ServerProfile> {
  return invoke<ServerProfile>("set_server_notes", { id, notes });
}

/** Forget any stored password/passphrase for a server (including its proxy's). */
export function forgetSecrets(id: string): Promise<void> {
  return invoke<void>("forget_secrets", { id });
}

/** Store a server's proxy/jump host secret (password or passphrase) in the OS
 *  keychain. The secret kind follows the proxy's own auth method. */
export function saveProxySecret(serverId: string, secret: string): Promise<void> {
  return invoke<void>("save_proxy_secret", { serverId, secret });
}

// ── Folders ─────────────────────────────────────────────────────────────────

/** All folder paths ("/"-separated, e.g. "Production/EU"). */
export function listFolders(): Promise<string[]> {
  return invoke<string[]>("list_folders");
}

/** Create a folder (and any missing ancestors); returns the full folder list. */
export function addFolder(path: string): Promise<string[]> {
  return invoke<string[]>("add_folder", { path });
}

/** Delete a folder and its descendants; servers inside move to the root. */
export function deleteFolder(path: string): Promise<void> {
  return invoke<void>("delete_folder", { path });
}

/** Delete a folder and its descendants **together with every server inside**
 *  (their saved secrets and live sessions are dropped too). */
export function deleteFolderWithServers(path: string): Promise<void> {
  return invoke<void>("delete_folder_with_servers", { path });
}

/** Move a folder (with its subtree) under newParent (null/empty = root). */
export function moveFolder(
  path: string,
  newParent: string | null,
): Promise<void> {
  return invoke<void>("move_folder", { path, newParent });
}

/** Rename a folder in place (keeps its parent), renaming its whole subtree. */
export function renameFolder(path: string, newName: string): Promise<void> {
  return invoke<void>("rename_folder", { path, newName });
}

/** Move a server into a folder (null/empty = root). */
export function setServerGroup(
  id: string,
  group: string | null,
): Promise<ServerProfile> {
  return invoke<ServerProfile>("set_server_group", { id, group });
}

// ── Backup (export / import) ───────────────────────────────────────────────────

/** Which data sections a backup carries — also the export preset the user picks. */
export type BackupKind = "servers" | "settings" | "recordings" | "all";

/**
 * Result of importing a backup. Each section count is `null` when the backup
 * didn't include it (so the UI reports only what was restored). `kind` echoes the
 * backup's declared kind; `settings` is the opaque UI snapshot to apply (if any).
 */
export interface ImportResult {
  kind: BackupKind;
  servers: number | null;
  folders: number | null;
  recordings: number | null;
  settings: unknown | null;
}

/**
 * Write a backup `.zip` archive to `path`. `kind` chooses which sections go in
 * (servers + folders, UI settings, recordings, or all). Secrets are never
 * exported — they stay in the OS keychain.
 */
export function exportBackup(path: string, kind: BackupKind, settings: unknown): Promise<void> {
  return invoke<void>("export_backup", { path, kind, settings });
}

/**
 * Restore a backup from `path`. The backend auto-detects the format (`.zip`
 * archive or legacy `.json`) and restores exactly the sections it contains.
 */
export function importBackup(path: string): Promise<ImportResult> {
  return invoke<ImportResult>("import_backup", { path });
}

/** Native "save as" dialog for a backup archive; returns the chosen path or null. */
export function pickBackupSavePath(defaultName: string): Promise<string | null> {
  return save({
    defaultPath: defaultName,
    filters: [{ name: "vterm backup", extensions: ["zip"] }],
  });
}

/** Native open dialog for a backup file; returns the chosen path or null. */
export async function pickBackupFile(): Promise<string | null> {
  const res = await open({
    multiple: false,
    directory: false,
    title: "Import backup",
    // Accept the current .zip archives and legacy .json backups.
    filters: [{ name: "vterm backup", extensions: ["zip", "json"] }],
  });
  return typeof res === "string" ? res : null;
}

/** Open a native file picker for a private key; returns the chosen path or null. */
export async function pickKeyFile(): Promise<string | null> {
  const res = await open({
    multiple: false,
    directory: false,
    title: "Select private key",
  });
  return typeof res === "string" ? res : null;
}
