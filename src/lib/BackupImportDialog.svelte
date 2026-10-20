<script lang="ts" module>
  import type { ImportCatalog } from "./api/servers";
  import type { ImportMode, ImportPlan } from "./backupimport";

  /** What the user chose to import. */
  export interface ImportChoice {
    /** The catalog to write; null — the servers stay as they are. */
    catalog: ImportCatalog | null;
    plan: ImportPlan | null;
    mode: ImportMode;
    settings: boolean;
    recordings: boolean;
  }
</script>

<script lang="ts">
  // The import preview (v1.20), shown for every backup before anything is
  // written: what the backup holds and which parts to take; for its servers,
  // whether they replace the current ones or are added to them, and the logins
  // and key paths to change on the way — a backup made for someone else
  // carries the logins and home directory of whoever exported it. Everything
  // it decides is `backupimport.ts`; the parent writes the result.
  import Modal from "./Modal.svelte";
  import InfoHint from "./InfoHint.svelte";
  import type { BackupContents } from "./api/servers";
  import type { ServerProfile } from "./types";
  import { keyPathRows, loginRows, planImport, remapServers, type UsageRow } from "./backupimport";
  import { t } from "./i18n";

  let {
    open = false,
    contents = null,
    fileName = "",
    current = [],
    currentFolders = [],
    onimport,
    oncancel,
  }: {
    open?: boolean;
    contents?: BackupContents | null;
    fileName?: string;
    /** The servers and folders there are now. */
    current?: ServerProfile[];
    currentFolders?: string[];
    onimport?: (choice: ImportChoice) => void;
    oncancel?: () => void;
  } = $props();

  let takeServers = $state(true);
  let takeSettings = $state(true);
  let takeRecordings = $state(true);
  let mode = $state<ImportMode>("merge");
  let logins = $state<Record<string, string>>({});
  let keys = $state<Record<string, string>>({});

  // Each backup starts afresh: everything it holds is taken, nothing is
  // renamed, and its servers are added — replacing is the choice that removes
  // something, so it is never the one already made.
  $effect(() => {
    if (!open || !contents) return;
    takeServers = contents.servers !== null;
    takeSettings = contents.settings;
    takeRecordings = contents.recordings !== null;
    mode = "merge";
    logins = {};
    keys = {};
  });

  const servers = $derived(contents?.servers ?? null);
  const loginList = $derived(servers ? loginRows(servers) : []);
  const keyList = $derived(servers ? keyPathRows(servers) : []);
  const plan = $derived(
    servers && takeServers
      ? planImport(
          mode,
          current,
          currentFolders,
          remapServers(servers, logins, keys, current),
          contents?.folders ?? [],
        )
      : null,
  );
  const holdsSomething = $derived(
    !!contents && (contents.servers !== null || contents.settings || contents.recordings !== null),
  );
  const chosen = $derived(
    (takeServers && servers !== null) ||
      (takeSettings && !!contents?.settings) ||
      (takeRecordings && contents?.recordings != null),
  );
  const removes = $derived(!!plan && plan.removed > 0);

  function usageText(row: UsageRow): string {
    const parts: string[] = [];
    if (row.servers > 0) parts.push(t("backup.usedBy", { servers: row.servers }));
    if (row.jumps > 0) parts.push(t("backup.usedByJumps", { jumps: row.jumps }));
    return parts.join(", ");
  }

  function submit() {
    if (!chosen) return;
    onimport?.({
      catalog: plan?.catalog ?? null,
      plan,
      mode,
      settings: takeSettings && !!contents?.settings,
      recordings: takeRecordings && contents?.recordings != null,
    });
  }
</script>

{#snippet remapTable(rows: UsageRow[], values: Record<string, string>, mono: boolean, testid: string)}
  <div class="space-y-1" data-testid={testid}>
    {#each rows as row (row.value)}
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs text-text {mono ? 'font-mono' : ''}" title={row.value}>{row.value}</div>
          <div class="text-caption text-muted">{usageText(row)}</div>
        </div>
        <input
          bind:value={values[row.value]}
          placeholder={t("backup.unchanged")}
          aria-label={t("backup.replaceWith", { value: row.value })}
          spellcheck="false"
          autocomplete="off"
          class="w-44 shrink-0 rounded border border-edge bg-panel px-2 py-1 text-xs text-text outline-none focus:border-accent {mono
            ? 'font-mono'
            : ''}"
        />
      </div>
    {/each}
  </div>
{/snippet}

<Modal {open} title={t("backup.title")} width="w-[36rem]" onclose={oncancel}>
  {#if contents}
    <p class="mb-3 break-all text-xs text-muted" data-testid="backup-file">{fileName}</p>

    {#if !holdsSomething}
      <p class="text-xs text-muted" data-testid="backup-empty">{t("settings.restoredNothing")}</p>
    {:else}
      <div class="mb-1 text-caption uppercase tracking-wider text-muted">{t("backup.what")}</div>
      <div class="space-y-1.5 text-xs">
        {#if contents.servers !== null}
          <label class="flex items-center gap-2 text-text">
            <input type="checkbox" bind:checked={takeServers} data-testid="backup-take-servers" />
            {t("backup.servers")}
            <span class="text-muted">
              {t("backup.serversCount", {
                servers: contents.servers.length,
                folders: contents.folders?.length ?? 0,
              })}
            </span>
          </label>
        {/if}
        {#if contents.settings}
          <label class="flex items-center gap-2 text-text">
            <input type="checkbox" bind:checked={takeSettings} data-testid="backup-take-settings" />
            {t("backup.settings")}
            <span class="text-muted">{t("backup.settingsHint")}</span>
          </label>
        {/if}
        {#if contents.recordings !== null}
          <label class="flex items-center gap-2 text-text">
            <input type="checkbox" bind:checked={takeRecordings} data-testid="backup-take-recordings" />
            {t("backup.recordings")}
            <span class="text-muted">{t("backup.recordingsCount", { count: contents.recordings })}</span>
          </label>
        {/if}
      </div>

      {#if servers && takeServers}
        <div class="mb-1 mt-4 text-caption uppercase tracking-wider text-muted">{t("backup.mode")}</div>
        <div class="space-y-1.5" role="radiogroup" aria-label={t("backup.mode")}>
          <label class="flex cursor-pointer items-start gap-2 rounded border border-edge px-2.5 py-2 hover:bg-edge/30">
            <input type="radio" bind:group={mode} value="merge" data-testid="backup-mode-merge" />
            <span>
              <span class="block text-sm text-text">{t("backup.merge")}</span>
              <span class="block text-caption text-muted">{t("backup.mergeHint")}</span>
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 rounded border border-edge px-2.5 py-2 hover:bg-edge/30">
            <input type="radio" bind:group={mode} value="replace" data-testid="backup-mode-replace" />
            <span>
              <span class="block text-sm text-text">{t("backup.replace")}</span>
              <span class="block text-caption text-muted">{t("backup.replaceHint", { count: current.length })}</span>
            </span>
          </label>
        </div>

        {#if loginList.length > 0}
          <div class="mb-1 mt-4 flex items-center gap-1 text-caption uppercase tracking-wider text-muted">
            {t("backup.logins")}<InfoHint text={t("backup.loginsHint")} />
          </div>
          {@render remapTable(loginList, logins, false, "backup-logins")}
        {/if}
        {#if keyList.length > 0}
          <div class="mb-1 mt-4 flex items-center gap-1 text-caption uppercase tracking-wider text-muted">
            {t("backup.keyPaths")}<InfoHint text={t("backup.keyPathsHint")} />
          </div>
          {@render remapTable(keyList, keys, true, "backup-keys")}
        {/if}

        <p class="mt-4 text-xs text-muted">{t("backup.secrets")}</p>
        {#if plan}
          <p class="mt-1 text-xs {removes ? 'text-warn' : 'text-muted'}" data-testid="backup-plan">
            {mode === "merge"
              ? t("backup.planMerge", { added: plan.added, skipped: plan.skipped })
              : t("backup.planReplace", { added: plan.added, removed: plan.removed })}
          </p>
        {/if}
      {/if}
    {/if}

    <div class="mt-4 flex items-center justify-end gap-2">
      {#if holdsSomething && !chosen}
        <span class="mr-auto text-xs text-muted" data-testid="backup-nothing">{t("backup.nothingChosen")}</span>
      {/if}
      <button type="button" class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={() => oncancel?.()}>
        {t("common.cancel")}
      </button>
      {#if holdsSomething}
        <button
          type="button"
          data-testid="backup-import-confirm"
          disabled={!chosen}
          class="rounded px-3 py-1 text-sm text-panel-alt hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 {removes
            ? 'bg-danger'
            : 'bg-accent hover:bg-accent-hover'}"
          onclick={submit}
        >
          {t("common.import")}
        </button>
      {/if}
    </div>
  {/if}
</Modal>
