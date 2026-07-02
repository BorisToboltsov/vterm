<script lang="ts">
  import {
    settings,
    resetSettings,
    clampMaxOpenMb,
    MAX_OPEN_MB_LIMIT,
  } from "./settings.svelte";
  import Icon from "./Icon.svelte";
  import AiSettingsSection from "./AiSettingsSection.svelte";
  import AppearanceSettings from "./AppearanceSettings.svelte";
  import SmartLogsSettings from "./SmartLogsSettings.svelte";
  import StatusBarSettings from "./StatusBarSettings.svelte";
  import SnippetsSettings from "./SnippetsSettings.svelte";
  import BackupSettings from "./BackupSettings.svelte";
  import ServerToolsPanel from "./ServerToolsPanel.svelte";
  import {
    SETTINGS_GROUPS,
    DEFAULT_SETTINGS_GROUP,
    visibleSectionIds,
    groupMatchCounts,
    groupForSection,
  } from "./settingsNav";
  import { t, availableLocales, type MessageKey } from "./i18n";

  // Sidebar group labels (data-driven keys would not type-check against MessageKey).
  const GROUP_LABEL: Record<string, MessageKey> = {
    general: "settings.groupGeneral",
    appearance: "settings.groupAppearance",
    terminal: "settings.groupTerminal",
    connection: "settings.groupConnection",
    files: "settings.groupFiles",
    sessions: "settings.groupSessions",
    assistant: "settings.groupAssistant",
  };

  let {
    open = $bindable(false),
    onImported,
    toolsSessionId = null,
    onInstallTool,
    initialSection = null,
  }: {
    open?: boolean;
    onImported?: () => void;
    /** Active SSH session id for the server-tools catalogue (Phase 12.8). */
    toolsSessionId?: string | null;
    onInstallTool?: (tool: import("./servertools").ToolStatus) => void;
    /** Deep-link: open the panel focused on this section's group (Phase 15.3). */
    initialSection?: string | null;
  } = $props();


  // ── Settings navigation (two-pane: group sidebar + cross-group search) ───────
  // Section data + grouping + visibility logic live in settingsNav.ts (pure,
  // unit-tested). The right pane renders the active group's sections, or — while
  // searching — every section matching the query across all groups.
  let search = $state("");
  let activeGroup = $state<string>(DEFAULT_SETTINGS_GROUP);
  const searching = $derived(search.trim().length > 0);
  const visibleIds = $derived(visibleSectionIds(search, activeGroup));
  const show = (id: string) => visibleIds.has(id);
  const noResults = $derived(visibleIds.size === 0);
  const matchCounts = $derived(groupMatchCounts(search));
  function selectGroup(id: string) {
    activeGroup = id;
    search = "";
  }

  // Deep-link: when opened with an initialSection, focus its group.
  $effect(() => {
    if (open && initialSection) {
      const gid = groupForSection(initialSection);
      if (gid) {
        activeGroup = gid;
        search = "";
      }
    }
  });

  // Roving keyboard navigation for the group sidebar (Arrow/Home/End).
  let navEl = $state<HTMLElement>();
  function focusGroup(id: string) {
    (navEl?.querySelector(`[data-testid="settings-group-${id}"]`) as HTMLElement | null)?.focus();
  }
  function onNavKey(e: KeyboardEvent, idx: number) {
    const n = SETTINGS_GROUPS.length;
    let next = -1;
    if (e.key === "ArrowDown") next = (idx + 1) % n;
    else if (e.key === "ArrowUp") next = (idx - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    const g = SETTINGS_GROUPS[next];
    selectGroup(g.id);
    focusGroup(g.id);
  }
</script>

{#if open}
  <div class="fixed inset-0 z-40 flex items-center justify-center">
    <button
      class="absolute inset-0 bg-black/50"
      aria-label={t("settings.close")}
      onclick={() => (open = false)}
    ></button>
    <div
      class="relative flex max-h-[85vh] w-[46rem] flex-col rounded-lg border border-edge bg-panel-alt"
    >
      <div class="flex items-center justify-between border-b border-edge px-4 py-3">
        <h2 class="text-sm font-semibold text-accent">{t("settings.title")}</h2>
        <button
          class="rounded px-2 text-muted hover:text-white"
          aria-label={t("common.close")}
          onclick={() => (open = false)}>×</button
        >
      </div>

      <div class="border-b border-edge px-4 py-2">
        <input
          data-testid="settings-search"
          type="search"
          placeholder={t("settings.searchPlaceholder")}
          aria-label={t("settings.searchAria")}
          class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          bind:value={search}
        />
      </div>

      <div class="flex min-h-0 flex-1 overflow-hidden">
        <!-- Group sidebar (Phase 15: two-pane navigation) -->
        <nav
          bind:this={navEl}
          class="w-44 shrink-0 overflow-y-auto border-r border-edge p-2"
          aria-label={t("settings.groupsAria")}
        >
          {#each SETTINGS_GROUPS as g, gi (g.id)}
            <button
              type="button"
              data-testid={`settings-group-${g.id}`}
              tabindex={activeGroup === g.id ? 0 : -1}
              class="mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm {!searching &&
              activeGroup === g.id
                ? 'bg-edge text-white'
                : 'text-muted hover:bg-edge/50 hover:text-white'}"
              aria-current={!searching && activeGroup === g.id ? "page" : undefined}
              onclick={() => selectGroup(g.id)}
              onkeydown={(e) => onNavKey(e, gi)}
            >
              <Icon name={g.icon} class="h-4 w-4 shrink-0" />
              <span class="flex-1 truncate">{t(GROUP_LABEL[g.id])}</span>
              {#if searching && matchCounts[g.id] > 0}
                <span class="rounded bg-accent/20 px-1.5 text-[10px] text-accent"
                  >{matchCounts[g.id]}</span
                >
              {/if}
            </button>
          {/each}
        </nav>

        <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
          <!-- Sticky header: active group name, or search-results mode (Phase 15.3) -->
          <div
            class="sticky -top-4 z-10 -mx-4 -mt-4 mb-0 border-b border-edge bg-panel-alt px-4 py-2 text-xs font-semibold text-white"
            data-testid="settings-active-header"
          >
            {searching ? t("settings.searchResults") : t(GROUP_LABEL[activeGroup])}
          </div>
          {#if noResults}
            <p class="py-6 text-center text-xs text-muted">{t("common.nothingFound")}</p>
          {/if}
        {#if show("language")}
        <!-- Language -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionLanguage")}</h3>
          <label class="block text-xs text-muted">
            {t("settings.languageLabel")}
            <select
              data-testid="language-select"
              class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
              bind:value={settings.language}
            >
              {#each availableLocales as loc (loc.id)}
                <option value={loc.id}>{loc.nativeName}</option>
              {/each}
            </select>
          </label>
        </section>

        {/if}
        {#if show("appearance")}
        <AppearanceSettings />
        {/if}

        {#if show("cursor")}
        <!-- Cursor -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionCursor")}</h3>
          <div class="flex items-center gap-4">
            <label class="block flex-1 text-xs text-muted">
              {t("settings.cursorStyle")}
              <select
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.cursorStyle}
              >
                <option value="block">{t("settings.cursorBlock")}</option>
                <option value="bar">{t("settings.cursorBar")}</option>
                <option value="underline">{t("settings.cursorUnderline")}</option>
              </select>
            </label>
            <label class="mt-4 flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" bind:checked={settings.cursorBlink} />
              {t("settings.cursorBlink")}
            </label>
          </div>
        </section>

        {/if}

        {#if show("terminal")}
        <!-- Terminal -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionTerminal")}</h3>
          <div class="flex gap-2">
            <label class="block flex-1 text-xs text-muted">
              {t("settings.scrollback")}
              <input
                type="number"
                min="0"
                max="100000"
                step="500"
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.scrollback}
              />
            </label>
            <label class="block flex-1 text-xs text-muted">
              {t("settings.bell")}
              <select
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.bell}
              >
                <option value="none">{t("settings.bellNone")}</option>
                <option value="sound">{t("settings.bellSound")}</option>
                <option value="visual">{t("settings.bellVisual")}</option>
              </select>
            </label>
          </div>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.copyOnSelect} />
            {t("settings.copyOnSelect")}
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.middleClickPaste} />
            {t("settings.middleClickPaste")}
          </label>
        </section>

        {/if}

        {#if show("smartlogs")}
        <SmartLogsSettings />
        {/if}

        {#if show("recording")}
        <!-- Session recording (Phase 11) -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionRecording")}</h3>
          <label class="block text-xs text-muted">
            {t("settings.recordMode")}
            <select
              class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
              bind:value={settings.recordMode}
            >
              <option value="full">{t("settings.recordModeFull")}</option>
              <option value="fullNoTiming">{t("settings.recordModeNoTiming")}</option>
              <option value="commands">{t("settings.recordModeCommands")}</option>
            </select>
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.recordMaskPasswords} />
            {t("settings.recordMaskPasswords")}
          </label>
          <p class="mt-1 text-[11px] text-muted/80">{t("settings.recordMaskPasswordsHint")}</p>
          <label class="mt-3 block text-xs text-muted">
            {t("settings.recordIdlePause")}
            <input
              type="number"
              min="0"
              step="5"
              class="mt-1 w-24 rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
              bind:value={settings.recordIdlePauseSecs}
            />
          </label>
          <p class="mt-1 text-[11px] text-muted/80">{t("settings.recordIdlePauseHint")}</p>
        </section>

        {/if}

        {#if show("servertools")}
        <!-- Server tools install helper (Phase 12.8) -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionServerTools")}</h3>
          <p class="mb-2 text-[11px] text-muted">{t("settings.serverToolsNote")}</p>
          <ServerToolsPanel sessionId={toolsSessionId} onInstall={(tool) => onInstallTool?.(tool)} />
        </section>

        {/if}

        {#if show("snippets")}
        <SnippetsSettings />
        {/if}

        {#if show("sftp")}
        <!-- SFTP (Phase 12) -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionSftp")}</h3>
          <label class="block w-40 text-xs text-muted">
            {t("settings.sftpMaxOpenMb")}
            <input
              type="number"
              min="1"
              max={MAX_OPEN_MB_LIMIT}
              class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
              value={settings.sftp.maxOpenMb}
              onchange={(e) => (settings.sftp.maxOpenMb = clampMaxOpenMb(e.currentTarget.valueAsNumber))}
            />
          </label>
          <p class="mt-1 text-[11px] text-muted">{t("settings.sftpMaxOpenMbHint")}</p>
        </section>

        {/if}

        {#if show("editor")}
        <!-- Config editor (Phase 12) -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionEditor")}</h3>
          <label class="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.editor.diffBeforeSave} />
            {t("settings.editorDiffBeforeSave")}
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.editor.lint} />
            {t("settings.editorLint")}
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.editor.backupOnSave} />
            {t("settings.editorBackup")}
          </label>
        </section>

        {/if}

        {#if show("behavior")}
        <!-- Behavior -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionBehavior")}</h3>
          <label class="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.confirmCloseTab} />
            {t("settings.confirmCloseTab")}
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.autoReconnect} />
            {t("settings.autoReconnect")}
          </label>
        </section>

        {/if}

        {#if show("connection")}
        <!-- Connection -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">
            {t("settings.sectionConnection")}
          </h3>
          <p class="mb-2 text-[11px] text-muted">{t("settings.connectionNote")}</p>
          <div class="flex gap-2">
            <label class="block flex-1 text-xs text-muted">
              {t("settings.connectTimeout")}
              <input
                type="number"
                min="1"
                max="120"
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.connectTimeout}
              />
            </label>
            <label class="block flex-1 text-xs text-muted">
              {t("settings.keepalive")}
              <input
                type="number"
                min="0"
                max="600"
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.keepaliveInterval}
              />
            </label>
          </div>
          <label class="mt-2 block w-32 text-xs text-muted">
            {t("settings.defaultPort")}
            <input
              type="number"
              min="1"
              max="65535"
              class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
              bind:value={settings.defaultPort}
            />
          </label>
        </section>

        {/if}

        {#if show("statusbar")}
        <StatusBarSettings />
        {/if}

        {#if show("security")}
        <!-- Security -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionSecurity")}</h3>
          <label class="block text-xs text-muted">
            {t("settings.hostKeyPolicy")}
            <select
              class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
              bind:value={settings.hostKeyPolicy}
            >
              <option value="strict">{t("settings.hostKeyStrict")}</option>
              <option value="ask">{t("settings.hostKeyAsk")}</option>
              <option value="accept">{t("settings.hostKeyAccept")}</option>
            </select>
          </label>
        </section>

        {/if}

        {#if show("backup")}
        <BackupSettings {onImported} />
        {/if}

        {#if show("ai")}
        <!-- AI assistant (Phase 17, opt-in) -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionAi")}</h3>
          <AiSettingsSection />
        </section>
        {/if}
        </div>
      </div>

      <div class="flex items-center justify-between border-t border-edge px-4 py-3">
        <button
          class="rounded px-2 py-1 text-xs text-muted hover:text-danger"
          onclick={resetSettings}>{t("settings.resetDefaults")}</button
        >
        <button
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
          onclick={() => (open = false)}>{t("common.done")}</button
        >
      </div>
    </div>
  </div>
{/if}

