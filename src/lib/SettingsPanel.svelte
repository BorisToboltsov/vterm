<script lang="ts">
  import {
    applyImportedSettings,
    settings,
    resetSettings,
    activeTerminalTheme,
    defaultHighlightRules,
    type StatusBarItems,
    type ThresholdKey,
    type HighlightColor,
  } from "./settings.svelte";
  import { THEMES, themeSwatches, type TerminalTheme, type ThemeDef } from "./themes";
  import {
    exportBackup,
    importBackup,
    pickBackupFile,
    pickBackupSavePath,
    type BackupKind,
  } from "./api";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";
  import { slide } from "svelte/transition";
  import { matchesQuery } from "./util";
  import { t, availableLocales, type MessageKey } from "./i18n";

  let {
    open = $bindable(false),
    onImported,
  }: { open?: boolean; onImported?: () => void } = $props();

  // ── Highlight rules (Phase 10) ─────────────────────────────────────────────
  let highlightRulesOpen = $state(false);
  const HIGHLIGHT_COLORS: HighlightColor[] = [
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
  ];

  // Render colour swatches in the active theme's ANSI palette — the same colours
  // the highlight will actually use in the terminal.
  const swatchColor = (c: HighlightColor): string => activeTerminalTheme()[c];

  /** Is a rule's regex valid? Drives an inline invalid-pattern hint. */
  function patternValid(pattern: string): boolean {
    if (!pattern) return false;
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }

  function addRule() {
    settings.highlightRules = [
      ...settings.highlightRules,
      {
        id: crypto.randomUUID(),
        name: "",
        pattern: "",
        color: "yellow",
        enabled: true,
        caseSensitive: false,
        wholeLine: false,
        bold: false,
        background: false,
      },
    ];
  }

  function removeRule(id: string) {
    settings.highlightRules = settings.highlightRules.filter((r) => r.id !== id);
  }

  // Rule order is priority (earliest match wins), so moving reorders precedence.
  function moveRule(index: number, dir: -1 | 1) {
    const to = index + dir;
    const rules = settings.highlightRules;
    if (to < 0 || to >= rules.length) return;
    const next = [...rules];
    [next[index], next[to]] = [next[to], next[index]];
    settings.highlightRules = next;
  }

  function resetRules() {
    settings.highlightRules = defaultHighlightRules();
  }

  // ── Backup export / import ─────────────────────────────────────────────────
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

  // Theme picker groups (visual swatch chips instead of a plain dropdown). The
  // group label is a message key, resolved reactively in the markup.
  const themeGroups: { labelKey: MessageKey; items: ThemeDef[] }[] = [
    { labelKey: "settings.themeGroupLight", items: THEMES.filter((th) => th.group === "light") },
    { labelKey: "settings.themeGroupModern", items: THEMES.filter((th) => th.group === "modern") },
    { labelKey: "settings.themeGroupRetro", items: THEMES.filter((th) => th.group === "retro") },
  ];

  // Editable swatches for the custom terminal palette.
  const swatches: { key: keyof TerminalTheme; labelKey: MessageKey }[] = [
    { key: "background", labelKey: "settings.swatch.background" },
    { key: "foreground", labelKey: "settings.swatch.foreground" },
    { key: "cursor", labelKey: "settings.swatch.cursor" },
    { key: "black", labelKey: "settings.swatch.black" },
    { key: "red", labelKey: "settings.swatch.red" },
    { key: "green", labelKey: "settings.swatch.green" },
    { key: "yellow", labelKey: "settings.swatch.yellow" },
    { key: "blue", labelKey: "settings.swatch.blue" },
    { key: "magenta", labelKey: "settings.swatch.magenta" },
    { key: "cyan", labelKey: "settings.swatch.cyan" },
    { key: "white", labelKey: "settings.swatch.white" },
    { key: "brightBlack", labelKey: "settings.swatch.brightBlack" },
    { key: "brightRed", labelKey: "settings.swatch.brightRed" },
    { key: "brightGreen", labelKey: "settings.swatch.brightGreen" },
    { key: "brightYellow", labelKey: "settings.swatch.brightYellow" },
    { key: "brightBlue", labelKey: "settings.swatch.brightBlue" },
    { key: "brightMagenta", labelKey: "settings.swatch.brightMagenta" },
    { key: "brightCyan", labelKey: "settings.swatch.brightCyan" },
    { key: "brightWhite", labelKey: "settings.swatch.brightWhite" },
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
  const FONT_GROUP_KEY: Record<FontGroup, MessageKey> = {
    System: "settings.fontGroupSystem",
    Coding: "settings.fontGroupCoding",
    Retro: "settings.fontGroupRetro",
  };

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
  const currentTheme = $derived(THEMES.find((th) => th.id === settings.theme));
  const currentThemeName = $derived(
    currentTheme?.name ??
      (settings.theme === "custom" ? t("settings.themeCustomName") : settings.theme),
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
  const STATUS_ITEMS: { key: keyof StatusBarItems; labelKey: MessageKey }[] = [
    { key: "os", labelKey: "settings.metric.os" },
    { key: "host", labelKey: "settings.metric.host" },
    { key: "cpu", labelKey: "settings.metric.cpu" },
    { key: "load", labelKey: "settings.metric.load" },
    { key: "ram", labelKey: "settings.metric.ram" },
    { key: "swap", labelKey: "settings.metric.swap" },
    { key: "disk", labelKey: "settings.metric.disk" },
    { key: "diskio", labelKey: "settings.metric.diskio" },
    { key: "net", labelKey: "settings.metric.net" },
    { key: "netConns", labelKey: "settings.metric.netConns" },
    { key: "uptime", labelKey: "settings.metric.uptime" },
    { key: "users", labelKey: "settings.metric.users" },
    { key: "ip", labelKey: "settings.metric.ip" },
    { key: "topProc", labelKey: "settings.metric.topProc" },
    { key: "cpuTemp", labelKey: "settings.metric.cpuTemp" },
    { key: "kernel", labelKey: "settings.metric.kernel" },
    { key: "serverTime", labelKey: "settings.metric.serverTime" },
  ];

  // Status-bar thresholds (collapsible sub-section). Each numeric metric gets an
  // average (amber) and a limit (red); `unit` is shown next to the inputs.
  let thresholdsOpen = $state(false);
  const THRESHOLD_ITEMS: { key: ThresholdKey; labelKey: MessageKey; unit: string }[] = [
    { key: "cpu", labelKey: "settings.metric.cpu", unit: "%" },
    { key: "ram", labelKey: "settings.metric.ram", unit: "%" },
    { key: "swap", labelKey: "settings.metric.swap", unit: "%" },
    { key: "disk", labelKey: "settings.metric.disk", unit: "%" },
    { key: "inodes", labelKey: "settings.thresholdInodes", unit: "%" },
    { key: "fd", labelKey: "settings.thresholdFd", unit: "%" },
    { key: "load", labelKey: "settings.thresholdLoad", unit: "" },
    { key: "cpuTemp", labelKey: "settings.metric.cpuTemp", unit: "°C" },
  ];

  // ── Settings search ────────────────────────────────────────────────────────
  let search = $state("");
  // Each section is filterable by its title + keywords.
  // Keywords are intentionally bilingual (EN + RU) so search matches regardless
  // of the current UI language. They are not displayed.
  const SECTIONS: { id: string; keywords: string }[] = [
    { id: "language", keywords: "Language locale язык локаль english русский ru en интерфейс" },
    { id: "appearance", keywords: "Appearance theme font color size line height light dark preview custom внешний вид тема шрифт цвет размер" },
    { id: "cursor", keywords: "Cursor blink block bar underline курсор мигание блок линия подчёркивание" },
    { id: "terminal", keywords: "Terminal scrollback bell copy paste selection middle click терминал буфер сигнал копировать вставка" },
    { id: "smartlogs", keywords: "Logs text smart search find buffer highlight json structured логи текст поиск подсветка буфер регулярные" },
    { id: "recording", keywords: "Recording session asciicast password mask privacy idle pause auto запись сессий пароль маскирование приватность простой пауза автозапись" },
    { id: "behavior", keywords: "Behavior confirm close tab auto reconnect поведение подтверждение вкладка переподключение" },
    { id: "connection", keywords: "Connection timeout keepalive default port подключение таймаут порт" },
    { id: "statusbar", keywords: "Status bar metrics poll interval cpu ram disk threshold thresholds warn limit average пороги monitoring мониторинг статус-бар метрики" },
    { id: "security", keywords: "Security host key known_hosts policy strict trust accept безопасность ключ хоста политика" },
    { id: "backup", keywords: "Backup export import json restore резервная копия бэкап экспорт импорт восстановление" },
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
      aria-label={t("settings.close")}
      onclick={() => (open = false)}
    ></button>
    <div
      class="relative flex max-h-[85vh] w-[32rem] flex-col rounded-lg border border-edge bg-panel-alt"
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

      <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
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
        <!-- Appearance -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionAppearance")}</h3>
          <div class="mb-2">
            <button
              type="button"
              data-testid="theme-toggle"
              aria-expanded={themeOpen}
              onclick={() => (themeOpen = !themeOpen)}
              class="flex w-full items-center justify-between rounded text-xs text-muted hover:text-white"
            >
              <span>{t("settings.theme")}</span>
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
            <div role="radiogroup" aria-label={t("settings.theme")} class="mt-2 space-y-2">
              {#each themeGroups as grp (grp.labelKey)}
                <div>
                  <span class="mb-1 block text-[10px] uppercase tracking-wider text-muted">
                    {t(grp.labelKey)}
                  </span>
                  <div class="grid grid-cols-2 gap-1.5">
                    {#each grp.items as themeDef (themeDef.id)}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={settings.theme === themeDef.id}
                        data-testid="theme-option"
                        title={themeDef.name}
                        onclick={() => selectTheme(themeDef.id)}
                        class="flex items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition duration-150 {settings.theme ===
                        themeDef.id
                          ? 'border-accent bg-edge text-white'
                          : 'border-edge text-muted hover:bg-edge'}"
                      >
                        <span class="flex shrink-0 overflow-hidden rounded border border-edge">
                          {#each themeSwatches(themeDef) as c, ci (ci)}
                            <span class="h-4 w-2.5" style="background-color: {c}"></span>
                          {/each}
                        </span>
                        <span class="truncate">{themeDef.name}</span>
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
                {t("settings.themeCustom")}
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
                    <span class="truncate">{t(sw.labelKey)}</span>
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
              <span>{t("settings.font")}</span>
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
                <div role="radiogroup" aria-label={t("settings.font")} class="mt-2 space-y-2">
                  {#each FONT_GROUPS as g (g)}
                    <div>
                      <span class="mb-1 block text-[10px] uppercase tracking-wider text-muted">
                        {t(FONT_GROUP_KEY[g])}
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
              {t("settings.fontSize")}
              <input
                type="number"
                min="8"
                max="32"
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
                bind:value={settings.fontSize}
              />
            </label>
            <label class="block flex-1 text-xs text-muted">
              {t("settings.lineHeight")}
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
        <!-- Logs & text (Phase 10) -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionSmartLogs")}</h3>
          <label class="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.smartLogs.enabled} />
            {t("settings.smartLogsEnabled")}
          </label>
          <p class="mt-1 text-[11px] text-muted/80">{t("settings.smartLogsEnabledHint")}</p>
          {#if settings.smartLogs.enabled}
            <div transition:slide={{ duration: 200 }} class="mt-2 space-y-1.5">
              <label class="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" bind:checked={settings.smartLogs.search} />
                {t("settings.smartLogsSearch")}
              </label>
              <div class="flex items-center gap-2">
                <label class="flex flex-1 items-center gap-2 text-xs text-muted">
                  <input type="checkbox" bind:checked={settings.smartLogs.highlight} />
                  {t("settings.smartLogsHighlight")}
                </label>
                {#if settings.smartLogs.highlight}
                  <button
                    type="button"
                    data-testid="highlight-rules-toggle"
                    aria-expanded={highlightRulesOpen}
                    onclick={() => (highlightRulesOpen = !highlightRulesOpen)}
                    title={t("highlight.rulesSection")}
                    aria-label={t("highlight.rulesSection")}
                    class="rounded p-0.5 text-muted hover:text-white"
                  >
                    <Icon name={highlightRulesOpen ? "chevronDown" : "chevronRight"} size={14} />
                  </button>
                {/if}
              </div>

              {#if settings.smartLogs.highlight && highlightRulesOpen}
                <div transition:slide={{ duration: 200 }} class="mt-1 space-y-2">
                  {#each settings.highlightRules as rule, i (rule.id)}
                    <div class="space-y-1.5 rounded border border-edge p-2">
                      <div class="flex items-center gap-2">
                        <input
                          type="checkbox"
                          bind:checked={rule.enabled}
                          aria-label={t("highlight.enableRule")}
                        />
                        <input
                          bind:value={rule.name}
                          placeholder={t("highlight.namePlaceholder")}
                          class="min-w-0 flex-1 rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent"
                        />
                        <button
                          type="button"
                          onclick={() => moveRule(i, -1)}
                          disabled={i === 0}
                          title={t("highlight.moveUp")}
                          aria-label={t("highlight.moveUp")}
                          class="rounded p-0.5 text-muted hover:text-accent disabled:opacity-30 disabled:hover:text-muted"
                        >
                          <Icon name="chevronUp" size={13} />
                        </button>
                        <button
                          type="button"
                          onclick={() => moveRule(i, 1)}
                          disabled={i === settings.highlightRules.length - 1}
                          title={t("highlight.moveDown")}
                          aria-label={t("highlight.moveDown")}
                          class="rounded p-0.5 text-muted hover:text-accent disabled:opacity-30 disabled:hover:text-muted"
                        >
                          <Icon name="chevronDown" size={13} />
                        </button>
                        <button
                          type="button"
                          onclick={() => removeRule(rule.id)}
                          title={t("highlight.deleteRule")}
                          aria-label={t("highlight.deleteRule")}
                          class="rounded p-0.5 text-muted hover:text-danger"
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                      <input
                        bind:value={rule.pattern}
                        placeholder={t("highlight.patternPlaceholder")}
                        spellcheck="false"
                        class="w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-white outline-none focus:border-accent"
                      />
                      {#if rule.pattern && !patternValid(rule.pattern)}
                        <p class="text-[11px] text-danger">{t("highlight.invalidPattern")}</p>
                      {/if}
                      <div class="flex items-center gap-1.5">
                        {#each HIGHLIGHT_COLORS as c}
                          <button
                            type="button"
                            onclick={() => (rule.color = c)}
                            aria-label={t("highlight.color", { color: c })}
                            title={t("highlight.color", { color: c })}
                            class="h-4 w-4 rounded-full border {rule.color === c
                              ? 'ring-2 ring-accent'
                              : 'border-edge'}"
                            style="background:{swatchColor(c)}"
                          ></button>
                        {/each}
                        <label class="ml-auto flex items-center gap-1 text-[11px] text-muted">
                          <input type="checkbox" bind:checked={rule.caseSensitive} />
                          {t("highlight.caseSensitive")}
                        </label>
                      </div>
                      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                        <label class="flex items-center gap-1">
                          <input type="checkbox" bind:checked={rule.wholeLine} />
                          {t("highlight.wholeLine")}
                        </label>
                        <label class="flex items-center gap-1">
                          <input type="checkbox" bind:checked={rule.bold} />
                          {t("highlight.bold")}
                        </label>
                        <label class="flex items-center gap-1">
                          <input type="checkbox" bind:checked={rule.background} />
                          {t("highlight.background")}
                        </label>
                      </div>
                    </div>
                  {/each}
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      onclick={addRule}
                      class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-xs text-muted hover:bg-accent hover:text-panel-alt"
                    >
                      <Icon name="plus" size={13} />
                      {t("highlight.addRule")}
                    </button>
                    <button
                      type="button"
                      onclick={resetRules}
                      class="rounded px-2 py-1 text-xs text-muted hover:text-accent"
                    >
                      {t("highlight.resetRules")}
                    </button>
                  </div>
                </div>
              {/if}

              <label class="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" bind:checked={settings.smartLogs.jsonView} />
                {t("settings.smartLogsJson")}
              </label>
            </div>
          {/if}
        </section>

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
        <!-- Status bar -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionStatusBar")}</h3>
          <label class="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.showStatusBar} />
            {t("settings.showStatusBar")}
          </label>
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.statusBarExpanded} />
            {t("settings.expandedByDefault")}
          </label>
          <label class="mt-2 block text-xs text-muted">
            {t("settings.pollInterval")}
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
              <span>{t("settings.shownMetrics")}</span>
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
                    {t(it.labelKey)}
                  </label>
                {/each}
              </div>
            {/if}
          </div>

          <div class="mt-2">
            <button
              type="button"
              data-testid="thresholds-toggle"
              aria-expanded={thresholdsOpen}
              onclick={() => (thresholdsOpen = !thresholdsOpen)}
              class="flex w-full items-center justify-between rounded text-xs text-muted hover:text-white"
            >
              <span>{t("settings.thresholdsPre")}<span class="text-warn">{t("settings.thresholdsAmber")}</span>{t("settings.thresholdsMid")}<span class="text-danger">{t("settings.thresholdsRed")}</span>{t("settings.thresholdsPost")}</span>
              <Icon
                name={thresholdsOpen ? "chevronDown" : "chevronRight"}
                size={14}
                class="shrink-0"
              />
            </button>
            {#if thresholdsOpen}
              <div transition:slide={{ duration: 200 }} class="mt-2 space-y-1.5">
                <div class="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
                  <span>{t("settings.thresholdMetric")}</span>
                  <span class="w-20 text-center text-warn">{t("settings.thresholdAverage")}</span>
                  <span class="w-20 text-center text-danger">{t("settings.thresholdLimit")}</span>
                </div>
                {#each THRESHOLD_ITEMS as it (it.key)}
                  <div class="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-xs text-muted">
                    <span>{t(it.labelKey)}{it.unit ? ` (${it.unit})` : ""}</span>
                    <input
                      type="number"
                      min="0"
                      aria-label={t("settings.thresholdAverageAria", { label: t(it.labelKey) })}
                      class="w-20 rounded border border-edge bg-panel px-2 py-1 text-right text-sm text-white outline-none focus:border-accent"
                      bind:value={settings.statusBarThresholds[it.key].warn}
                    />
                    <input
                      type="number"
                      min="0"
                      aria-label={t("settings.thresholdLimitAria", { label: t(it.labelKey) })}
                      class="w-20 rounded border border-edge bg-panel px-2 py-1 text-right text-sm text-white outline-none focus:border-accent"
                      bind:value={settings.statusBarThresholds[it.key].crit}
                    />
                  </div>
                {/each}
                <p class="text-[11px] text-muted">{t("settings.thresholdNote")}</p>
              </div>
            {/if}
          </div>
        </section>

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
        <!-- Backup -->
        <section>
          <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionBackup")}</h3>
          <p class="mb-2 text-[11px] text-muted">{t("settings.backupNote")}</p>
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
