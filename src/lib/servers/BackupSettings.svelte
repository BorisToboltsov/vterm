<script lang="ts">
  // Backup export/import settings section: choose what to include, export a `.zip`,
  // or import one. An import is shown before anything is written (v1.20): the
  // backup is read, and `BackupImportDialog` says what it holds and what to take
  // — its servers added to the current ones or replacing them, logins and key
  // paths changed on the way. Extracted from SettingsPanel.svelte in Phase 18.5.
  // `onImported` lets the parent refresh its server/folder lists after a restore.
  import { settings, applyImportedSettings } from "../settings/settings.svelte";
  import {
    exportBackup,
    importBackup,
    listFolders,
    listServers,
    pickBackupFile,
    pickBackupSavePath,
    readBackup,
    type BackupContents,
    type BackupKind,
  } from "../api";
  import BackupImportDialog, { type ImportChoice } from "./BackupImportDialog.svelte";
  import { loadLocalDbs, localDbs } from "../stores/db.svelte";
  import InfoHint from "../ui/InfoHint.svelte";
  import { baseName } from "../files/fspath";
  import type { DbProfile, ServerProfile } from "../types";
  import { t } from "../i18n";

  let { onImported }: { onImported?: () => void } = $props();

  let backupMsg = $state("");
  let backupErr = $state(false);
  /** The backup on the preview, with the catalog it is compared against. */
  let pending = $state<{
    path: string;
    contents: BackupContents;
    servers: ServerProfile[];
    folders: string[];
    dbs: DbProfile[];
  } | null>(null);
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
      const done = await exportBackup(path, exportKind, $state.snapshot(settings));
      // What the library cannot read is not in the backup either — said, not dropped quietly.
      backupMsg = [
        t("settings.backupExported"),
        done.scriptsSkipped > 0 ? t("settings.backupScriptsSkipped", { count: done.scriptsSkipped }) : "",
      ]
        .filter(Boolean)
        .join(" ");
    } catch (e) {
      backupErr = true;
      backupMsg = t("settings.exportFailed", { error: String(e) });
    }
  }

  /** Pick a backup and show what it holds; nothing is written yet. */
  async function previewImport() {
    backupMsg = "";
    backupErr = false;
    try {
      const path = await pickBackupFile();
      if (!path) return;
      const [contents, servers, folders, dbs] = await Promise.all([
        readBackup(path),
        listServers(),
        listFolders(),
        // This computer's databases, as the database store reads them (ADR 0080).
        loadLocalDbs().then(localDbs),
      ]);
      pending = { path, contents, servers, folders, dbs };
    } catch (e) {
      backupErr = true;
      backupMsg = t("settings.importFailed", { error: String(e) });
    }
  }

  async function doImport(choice: ImportChoice) {
    const path = pending?.path;
    pending = null;
    if (!path) return;
    try {
      const result = await importBackup(
        path,
        choice.catalog,
        choice.recordings,
        choice.scripts,
        choice.localDatabases,
      );
      const appliedSettings = choice.settings && !!result.settings;
      if (appliedSettings) applyImportedSettings(result.settings);
      onImported?.();
      // Report only what was written.
      const parts: string[] = [];
      if (result.servers !== null && choice.plan) {
        parts.push(
          choice.mode === "merge"
            ? t("settings.restoredMerged", {
                added: choice.plan.added,
                skipped: choice.plan.skipped,
                folders: result.folders ?? 0,
              })
            : t("settings.restoredServers", { servers: result.servers, folders: result.folders ?? 0 }),
        );
      }
      if (result.localDatabases != null) {
        parts.push(t("settings.restoredLocalDbs", { count: result.localDatabases }));
      }
      if (appliedSettings) parts.push(t("settings.restoredSettings"));
      if (result.recordings !== null)
        parts.push(t("settings.restoredRecordings", { count: result.recordings }));
      if (result.scripts != null) parts.push(t("settings.restoredScripts", { count: result.scripts }));
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
      onclick={previewImport}>{t("settings.importBackup")}</button
    >
  </div>
  {#if backupMsg}
    <p class="mt-2 text-meta {backupErr ? 'text-danger' : 'text-muted'}" data-testid="backup-msg">
      {backupMsg}
    </p>
  {/if}
</section>

<BackupImportDialog
  open={!!pending}
  contents={pending?.contents ?? null}
  fileName={pending ? baseName(pending.path) : ""}
  current={pending?.servers ?? []}
  currentFolders={pending?.folders ?? []}
  currentDbs={pending?.dbs ?? []}
  onimport={doImport}
  oncancel={() => (pending = null)}
/>
