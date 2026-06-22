<script lang="ts">
  import {
    applyImportedSettings,
    settings,
    resetSettings,
    type StatusBarItems,
  } from "./settings.svelte";
  import { THEMES, themeSwatches, type TerminalTheme, type ThemeDef } from "./themes";
  import {
    exportBackup,
    importBackup,
    pickBackupFile,
    pickBackupSavePath,
  } from "./api";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";
  import { slide } from "svelte/transition";
  import { matchesQuery } from "./util";

  let {
    open = $bindable(false),
    onImported,
  }: { open?: boolean; onImported?: () => void } = $props();

  // ── Backup export / import ─────────────────────────────────────────────────
  let backupMsg = $state("");
  let backupErr = $state(false);
  let confirmImport = $state(false);

  function todayStamp(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async function doExport() {
    backupMsg = "";
    backupErr = false;
    try {
      const path = await pickBackupSavePath(`vterm-backup-${todayStamp()}.json`);
      if (!path) return;
      await exportBackup(path, $state.snapshot(settings));
      backupMsg = "Backup exported.";
    } catch (e) {
      backupErr = true;
      backupMsg = `Export failed: ${e}`;
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
      backupMsg = `Restored ${result.serverCount} server(s) and ${result.folderCount} folder(s).`;
    } catch (e) {
      backupErr = true;
      backupMsg = `Import failed: ${e}`;
    }
  }

  // Theme picker groups (visual swatch chips instead of a plain dropdown).
  const themeGroups: { label: string; items: ThemeDef[] }[] = [
    { label: "Light", items: THEMES.filter((t) => t.group === "light") },
    { label: "Modern", items: THEMES.filter((t) => t.group === "modern") },
    { label: "Retro", items: THEMES.filter((t) => t.group === "retro") },
  ];

  // Editable swatches for the custom terminal palette.
  const swatches: { key: keyof TerminalTheme; label: string }[] = [
    { key: "background", label: "Background" },
    { key: "foreground", label: "Foreground" },
    { key: "cursor", label: "Cursor" },
    { key: "black", label: "Black" },
    { key: "red", label: "Red" },
    { key: "green", label: "Green" },
    { key: "yellow", label: "Yellow" },
    { key: "blue", label: "Blue" },
    { key: "magenta", label: "Magenta" },
    { key: "cyan", label: "Cyan" },
    { key: "white", label: "White" },
    { key: "brightBlack", label: "Br. Black" },
    { key: "brightRed", label: "Br. Red" },
    { key: "brightGreen", label: "Br. Green" },
    { key: "brightYellow", label: "Br. Yellow" },
    { key: "brightBlue", label: "Br. Blue" },
    { key: "brightMagenta", label: "Br. Magenta" },
    { key: "brightCyan", label: "Br. Cyan" },
    { key: "brightWhite", label: "Br. White" },
  ];

  // Font choices grouped for the dropdown. Bundled fonts (Coding + Retro, see
  // +layout.svelte) work everywhere; "System" entries rely on the OS. Each value
  // keeps a generic `monospace` fallback.
  type FontGroup = "System" | "Coding" | "Retro";
  const FONTS: { label: string; value: string; group: FontGroup }[] = [
    { label: "System monospace", value: "ui-monospace, SFMono-Regular, Menlo, monospace", group: "System" },
    { label: "Menlo", value: "Menlo, monospace", group: "System" },
    { label: "Monaco", value: "Monaco, monospace", group: "System" },
    { label: "Courier New", value: "'Courier New', monospace", group: "System" },
    { label: "Cascadia Code", value: "'Cascadia Code', monospace", group: "Coding" },
    { label: "JetBrains Mono", value: "'JetBrains Mono', monospace", group: "Coding" },
    { label: "Fira Code", value: "'Fira Code', monospace", group: "Coding" },
    { label: "Source Code Pro", value: "'Source Code Pro', monospace", group: "Coding" },
    { label: "VT323 — CRT terminal", value: "'VT323', monospace", group: "Retro" },
    { label: "Press Start 2P — 8-bit", value: "'Press Start 2P', monospace", group: "Retro" },
    { label: "Share Tech Mono", value: "'Share Tech Mono', monospace", group: "Retro" },
  ];
  const FONT_GROUPS: FontGroup[] = ["System", "Coding", "Retro"];

  // Font that best matches each retro theme — applied when that theme is picked.
  const THEME_FONT: Record<string, string> = {
    fallout: "'VT323', monospace",
    amber: "'VT323', monospace",
    "ibm-3270": "'VT323', monospace",
    c64: "'Press Start 2P', monospace",
  };

  function onThemeChange(themeId: string) {
    const font = THEME_FONT[themeId];
    if (font) settings.fontFamily = font;
  }

  function selectTheme(themeId: string) {
    settings.theme = themeId;
    onThemeChange(themeId);
  }

  // The theme picker is a collapsible sub-section, collapsed by default.
  let themeOpen = $state(false);
  const currentTheme = $derived(THEMES.find((t) => t.id === settings.theme));
  const currentThemeName = $derived(
    currentTheme?.name ?? (settings.theme === "custom" ? "Custom" : settings.theme),
  );

  // The font picker mirrors the theme one: collapsible, collapsed by default.
  let fontOpen = $state(false);
  const currentFontLabel = $derived(
    FONTS.find((f) => f.value === settings.fontFamily)?.label ?? settings.fontFamily,
  );
  // Tiny Python snippet to preview the font (glyphs, ligatures, indentation).
  const FONT_SAMPLE = `def greet(name: str) -> str:
    return f"Hello, {name}!"  # 0O1lI

print(greet("world"))  # => 12345`;

  // Status-bar metric checkboxes (collapsible sub-section).
  let metricsOpen = $state(false);
  const STATUS_ITEMS: { key: keyof StatusBarItems; label: string }[] = [
    { key: "os", label: "OS" },
    { key: "host", label: "User @ host" },
    { key: "cpu", label: "CPU" },
    { key: "load", label: "Load average" },
    { key: "ram", label: "RAM" },
    { key: "swap", label: "Swap" },
    { key: "disk", label: "Disk" },
    { key: "diskio", label: "Disk I/O" },
    { key: "net", label: "Network" },
    { key: "netConns", label: "Connections" },
    { key: "uptime", label: "Uptime" },
    { key: "users", label: "Users" },
    { key: "ip", label: "IP address" },
    { key: "topProc", label: "Top process" },
    { key: "cpuTemp", label: "CPU temp" },
    { key: "kernel", label: "Kernel" },
    { key: "serverTime", label: "Server time" },
  ];

  // ── Settings search ────────────────────────────────────────────────────────
  let search = $state("");
  // Each section is filterable by its title + keywords.
  const SECTIONS: { id: string; keywords: string }[] = [
    { id: "appearance", keywords: "Appearance theme font color size line height light dark preview custom" },
    { id: "cursor", keywords: "Cursor blink block bar underline" },
    { id: "terminal", keywords: "Terminal scrollback bell copy paste selection middle click" },
    { id: "behavior", keywords: "Behavior confirm close tab auto reconnect" },
    { id: "connection", keywords: "Connection timeout keepalive default port" },
    { id: "statusbar", keywords: "Status bar metrics poll interval cpu ram disk" },
    { id: "security", keywords: "Security host key known_hosts policy strict trust accept" },
    { id: "backup", keywords: "Backup export import json restore" },
  ];
  const visibleIds = $derived(
    new Set(SECTIONS.filter((s) => matchesQuery(s.keywords, search)).map((s) => s.id)),
  );
  const show = (id: string) => visibleIds.has(id);
  const noResults = $derived(visibleIds.size === 0);
</script>

{#if open}
  <div class="fixed inset-0 z-40 flex items-center justify-center">
    <button
      class="absolute inset-0 bg-black/50"
      aria-label="Close settings"
      onclick={() => (open = false)}
    ></button>
    <div
      class="relative flex max-h-[85vh] w-[32rem] flex-col rounded-lg border border-edge bg-panel-alt"
    >
      <div class="flex items-center justify-between border-b border-edge px-4 py-3">
        <h2 class="text-sm font-semibold text-accent">Settings</h2>
        <button
          class="rounded px-2 text-muted hover:text-white"
          aria-label="Close"
          onclick={() => (open = false)}>×</button
        >
      </div>

      <div class="border-b border-edge px-4 py-2">
        <input
          data-testid="settings-search"
          type="search"
          placeholder="Search settings…"
          aria-label="Search settings"
          class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          bind:value={search}
        />
      </div>

      <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {#if noResults}
          <p class="py-6 text-center text-xs text-muted">Ничего не найдено</p>
        {/if}
        {#if show("appearance")}
        <!-- Appearance -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Appearance</h3>
          <div class="mb-2">
            <button
              type="button"
              data-testid="theme-toggle"
              aria-expanded={themeOpen}
              onclick={() => (themeOpen = !themeOpen)}
              class="flex w-full items-center justify-between rounded text-xs text-muted hover:text-white"
            >
              <span>Theme</span>
              <span class="flex min-w-0 items-center gap-2">
                {#if currentTheme}
                  <span class="flex shrink-0 overflow-hidden rounded border border-edge">
                    {#each themeSwatches(currentTheme) as c, ci (ci)}
                      <span class="h-3 w-2" style="background-color: {c}"></span>
                    {/each}
                  </span>
                {/if}
                <span class="truncate text-white">{currentThemeName}</span>
                <Icon
                  name={themeOpen ? "chevronDown" : "chevronRight"}
                  size={14}
                  class="shrink-0"
                />
              </span>
            </button>
            {#if themeOpen}
            <div transition:slide={{ duration: 200 }}>
            <div role="radiogroup" aria-label="Theme" class="mt-2 space-y-2">
              {#each themeGroups as grp (grp.label)}
                <div>
                  <span class="mb-1 block text-[10px] uppercase tracking-wider text-muted">
                    {grp.label}
                  </span>
                  <div class="grid grid-cols-2 gap-1.5">
                    {#each grp.items as t (t.id)}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={settings.theme === t.id}
                        data-testid="theme-option"
                        title={t.name}
                        onclick={() => selectTheme(t.id)}
                        class="flex items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition duration-150 {settings.theme ===
                        t.id
                          ? 'border-accent bg-edge text-white'
                          : 'border-edge text-muted hover:bg-edge'}"
                      >
                        <span class="flex shrink-0 overflow-hidden rounded border border-edge">
                          {#each themeSwatches(t) as c, ci (ci)}
                            <span class="h-4 w-2.5" style="background-color: {c}"></span>
                          {/each}
                        </span>
                        <span class="truncate">{t.name}</span>
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
              <button
                type="button"
                role="radio"
                aria-checked={settings.theme === "custom"}
                onclick={() => selectTheme("custom")}
                class="w-full rounded border px-2 py-1.5 text-left text-xs transition duration-150 {settings.theme ===
                'custom'
                  ? 'border-accent bg-edge text-white'
                  : 'border-edge text-muted hover:bg-edge'}"
              >
                Custom…
              </button>
            </div>

            {#if settings.theme === "custom"}
              <div class="mt-2 grid grid-cols-3 gap-2">
                {#each swatches as sw (sw.key)}
                  <label class="flex items-center gap-1 text-[11px] text-muted">
                    <input
                      type="color"
                      class="h-6 w-6 shrink-0 rounded border border-edge bg-panel"
                      bind:value={settings.customTheme[sw.key]}
                    />
                    <span class="truncate">{sw.label}</span>
                  </label>
                {/each}
              </div>
            {/if}
            </div>
            {/if}
          </div>

          <div class="mb-2">
            <button
              type="button"
              data-testid="font-toggle"
              aria-expanded={fontOpen}
              onclick={() => (fontOpen = !fontOpen)}
              class="flex w-full items-center justify-between rounded text-xs text-muted hover:text-white"
            >
              <span>Font</span>
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate text-white">{currentFontLabel}</span>
                <Icon
                  name={fontOpen ? "chevronDown" : "chevronRight"}
                  size={14}
                  class="shrink-0"
                />
              </span>
            </button>
            {#if fontOpen}
              <div transition:slide={{ duration: 200 }}>
                <div role="radiogroup" aria-label="Font" class="mt-2 space-y-2">
                  {#each FONT_GROUPS as g (g)}
                    <div>
                      <span class="mb-1 block text-[10px] uppercase tracking-wider text-muted">
                        {g}
                      </span>
                      <div class="grid grid-cols-2 gap-1.5">
                        {#each FONTS.filter((f) => f.group === g) as f (f.value)}
                          <button
                            type="button"
                            role="radio"
                            aria-checked={settings.fontFamily === f.value}
                            data-testid="font-option"
                            title={f.label}
                            onclick={() => (settings.fontFamily = f.value)}
                            style="font-family: {f.value}"
                            class="truncate rounded border px-2 py-1.5 text-left text-xs transition duration-150 {settings.fontFamily ===
                            f.value
                              ? 'border-accent bg-edge text-white'
                              : 'border-edge text-muted hover:bg-edge'}"
                          >
                            {f.label}
                          </button>
                        {/each}
                      </div>
                    </div>
                  {/each}
                </div>
                <!-- Live preview of the chosen font (a tiny Python snippet). -->
                <pre
                  data-testid="font-preview"
                  class="mt-2 overflow-x-auto rounded border border-edge bg-panel px-2 py-1.5 text-xs leading-snug text-white"
                  style="font-family: {settings.fontFamily}">{FONT_SAMPLE}</pre>
              </div>
            {/if}
          </div>
          <div class="flex gap-2">
            <label class="block flex-1 text-xs text-muted">
              Font size
              <input
                type="number"
                min="8"
                max="32"
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.fontSize}
              />
            </label>
            <label class="block flex-1 text-xs text-muted">
              Line height
              <input
                type="number"
                min="1"
                max="2"
                step="0.05"
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.lineHeight}
              />
            </label>
          </div>
        </section>

        {/if}

        {#if show("cursor")}
        <!-- Cursor -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Cursor</h3>
          <div class="flex items-center gap-4">
            <label class="block flex-1 text-xs text-muted">
              Style
              <select
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.cursorStyle}
              >
                <option value="block">Block</option>
                <option value="bar">Bar</option>
                <option value="underline">Underline</option>
              </select>
            </label>
            <label class="mt-4 flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" bind:checked={settings.cursorBlink} />
              Blink
            </label>
          </div>
        </section>

        {/if}

        {#if show("terminal")}
        <!-- Terminal -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Terminal</h3>
          <div class="flex gap-2">
            <label class="block flex-1 text-xs text-muted">
              Scrollback (lines)
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
              Bell
              <select
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.bell}
              >
                <option value="none">None</option>
                <option value="sound">Sound</option>
                <option value="visual">Visual</option>
              </select>
            </label>
          </div>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.copyOnSelect} />
            Copy on selection
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.middleClickPaste} />
            Paste on middle click
          </label>
        </section>

        {/if}

        {#if show("behavior")}
        <!-- Behavior -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Behavior</h3>
          <label class="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.confirmCloseTab} />
            Confirm before closing a tab with an active session
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.autoReconnect} />
            Auto-reconnect when a connection drops
          </label>
        </section>

        {/if}

        {#if show("connection")}
        <!-- Connection -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">
            Connection
          </h3>
          <p class="mb-2 text-[11px] text-muted">Applies to new connections.</p>
          <div class="flex gap-2">
            <label class="block flex-1 text-xs text-muted">
              Connect timeout (s)
              <input
                type="number"
                min="1"
                max="120"
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.connectTimeout}
              />
            </label>
            <label class="block flex-1 text-xs text-muted">
              Keepalive (s)
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
            Default port
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
        <!-- Status bar -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Status bar</h3>
          <label class="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.showStatusBar} />
            Show bottom status bar
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.statusBarExpanded} />
            Expanded view (names, byte totals, CPU graph) by default
          </label>
          <label class="mt-2 block text-xs text-muted">
            Metrics poll interval (s)
            <input
              type="number"
              min="1"
              max="120"
              class="mt-1 w-32 rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
              bind:value={settings.statusPollInterval}
            />
          </label>

          <div class="mt-2">
            <button
              type="button"
              data-testid="metrics-toggle"
              aria-expanded={metricsOpen}
              onclick={() => (metricsOpen = !metricsOpen)}
              class="flex w-full items-center justify-between rounded text-xs text-muted hover:text-white"
            >
              <span>Shown metrics</span>
              <Icon
                name={metricsOpen ? "chevronDown" : "chevronRight"}
                size={14}
                class="shrink-0"
              />
            </button>
            {#if metricsOpen}
              <div transition:slide={{ duration: 200 }} class="mt-2 grid grid-cols-2 gap-1.5">
                {#each STATUS_ITEMS as it (it.key)}
                  <label class="flex items-center gap-2 text-xs text-muted">
                    <input type="checkbox" bind:checked={settings.statusBarItems[it.key]} />
                    {it.label}
                  </label>
                {/each}
              </div>
            {/if}
          </div>
        </section>

        {/if}

        {#if show("security")}
        <!-- Security -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Security</h3>
          <label class="block text-xs text-muted">
            Host key policy (known_hosts)
            <select
              class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
              bind:value={settings.hostKeyPolicy}
            >
              <option value="strict">Strict — only keys already trusted</option>
              <option value="ask">Trust on first use — reject if changed</option>
              <option value="accept">Accept any — trust every key (insecure)</option>
            </select>
          </label>
        </section>

        {/if}

        {#if show("backup")}
        <!-- Backup -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Backup</h3>
          <p class="mb-2 text-[11px] text-muted">
            Экспорт списка серверов, их настроек, структуры папок и параметров приложения
            в JSON. Пароли/passphrase не входят в бэкап — они хранятся в системном keychain.
          </p>
          <div class="flex gap-2">
            <button
              data-testid="backup-export"
              class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
              onclick={doExport}>Export backup…</button
            >
            <button
              data-testid="backup-import"
              class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
              onclick={() => (confirmImport = true)}>Import backup…</button
            >
          </div>
          {#if backupMsg}
            <p
              class="mt-2 text-[11px] {backupErr ? 'text-danger' : 'text-muted'}"
              data-testid="backup-msg"
            >
              {backupMsg}
            </p>
          {/if}
        </section>
        {/if}
      </div>

      <div class="flex items-center justify-between border-t border-edge px-4 py-3">
        <button
          class="rounded px-2 py-1 text-xs text-muted hover:text-danger"
          onclick={resetSettings}>Reset to defaults</button
        >
        <button
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
          onclick={() => (open = false)}>Done</button
        >
      </div>
    </div>
  </div>
{/if}

<!-- Importing a backup replaces the current servers and folders. -->
<ConfirmDialog
  open={confirmImport}
  title="Import backup?"
  confirmLabel="Import"
  onconfirm={() => {
    confirmImport = false;
    doImport();
  }}
  oncancel={() => (confirmImport = false)}
>
  Текущий список серверов и структура папок будут заменены содержимым бэкапа.
  Сохранённые в keychain пароли затрагиваются только для перезаписанных серверов.
</ConfirmDialog>
