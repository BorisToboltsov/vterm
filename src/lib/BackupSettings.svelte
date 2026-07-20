<script lang="ts">
  // Backup export/import settings section: choose what to include, export a `.zip`,
  // or import one (replacing servers/folders, with a confirm). Extracted from
  // SettingsPanel.svelte in Phase 18.5; owns its import-confirm dialog. `onImported`
  // lets the parent refresh its server/folder lists after a restore.
  import { settings, applyImportedSettings } from "./settings.svelte";
  import {
    exportBackup,
    importBackup,
    pickBackupFile,
    pickBackupSavePath,
    type BackupKind,
  } from "./api";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import InfoHint from "./InfoHint.svelte";
  import { t } from "./i18n";

  let { onImported }: { onImported?: () => void } = $props();

  let backupMsg = $state("");
  let backupErr = $state(false);
  let confirmImport = $state(false);
  // What to include in an export. "all" by default; the others scope the archive.
  let exportKind = $state<BackupKind>("all");

  const BACKUP_KINDS: { kind: BackupKind; label: () => string }[] = [
    { kind: "all", label: () => t("settings.backupKindAll") },
    { kind: "servers", label: () => t("settings.backupKindServers") },
    { kind: "settings", label: () => t("settings.backupKindSettings") },
    { kind: "recordings", label: () => t("settings.backupKindRecordings") },
  ];

  function todayStamp(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async function doExport() {
    backupMsg = "";
    backupErr = false;
    try {
      const stem = exportKind === "all" ? "backup" : exportKind;
      const path = await pickBackupSavePath(`vterm-${stem}-${todayStamp()}.zip`);
      if (!path) return;
      await exportBackup(path, exportKind, $state.snapshot(settings));
      backupMsg = t("settings.backupExported");
    } catch (e) {
      backupErr = true;
      backupMsg = t("settings.exportFailed", { error: String(e) });
    }
  }

  async function doImport() {
    backupMsg = "";
    backupErr = false;
    try {
      const path = await pickBackupFile();
      if (!path) return;
      const result = await importBackup(path);
      if (result.settings) applyImportedSettings(result.settings);
      onImported?.();
      // Report only the sections the backup actually carried.
      const parts: string[] = [];
      if (result.servers !== null)
        parts.push(t("settings.restoredServers", { servers: result.servers, folders: result.folders ?? 0 }));
      if (result.settings) parts.push(t("settings.restoredSettings"));
      if (result.recordings !== null)
        parts.push(t("settings.restoredRecordings", { count: result.recordings }));
      backupMsg = parts.length ? parts.join(" ") : t("settings.restoredNothing");
    } catch (e) {
      backupErr = true;
      backupMsg = t("settings.importFailed", { error: String(e) });
    }
  }
</script>

<!-- Backup -->
<section>
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionBackup")}<InfoHint text={t("settings.backupNote")} />
  </h3>
  <label class="mb-2 flex items-center gap-2 text-xs text-muted" for="backup-kind">
    {t("settings.backupWhat")}
    <select
      id="backup-kind"
      data-testid="backup-kind"
      bind:value={exportKind}
      class="rounded border border-edge bg-panel px-2 py-1 text-sm text-text"
    >
      {#each BACKUP_KINDS as opt}
        <option value={opt.kind}>{opt.label()}</option>
      {/each}
    </select>
  </label>
  <div class="flex gap-2">
    <button
      data-testid="backup-export"
      class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
      onclick={doExport}>{t("settings.exportBackup")}</button
    >
    <button
      data-testid="backup-import"
      class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
      onclick={() => (confirmImport = true)}>{t("settings.importBackup")}</button
    >
  </div>
  {#if backupMsg}
    <p class="mt-2 text-meta {backupErr ? 'text-danger' : 'text-muted'}" data-testid="backup-msg">
      {backupMsg}
    </p>
  {/if}
</section>

<!-- Importing a backup replaces the current servers and folders. -->
<ConfirmDialog
  open={confirmImport}
  title={t("settings.importTitle")}
  confirmLabel={t("common.import")}
  onconfirm={() => {
    confirmImport = false;
    doImport();
  }}
  oncancel={() => (confirmImport = false)}
>
  {t("settings.importBody")}
</ConfirmDialog>
