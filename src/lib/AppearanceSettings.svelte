<script lang="ts">
  // Appearance settings section: terminal theme picker (swatch chips + custom
  // palette) and font picker (grouped + live preview) plus size/line-height.
  // Extracted from SettingsPanel.svelte in Phase 18.5. Reads/writes the settings
  // store directly, like AiSettingsSection.
  import { settings } from "./settings.svelte";
  import { THEMES, themeSwatches, type TerminalTheme, type ThemeDef } from "./themes";
  import DisclosureRow from "./DisclosureRow.svelte";
  import { t, type MessageKey } from "./i18n";
  import { slide } from "svelte/transition";

  // Theme picker groups (visual swatch chips instead of a plain dropdown). The
  // group label is a message key, resolved reactively in the markup.
  const themeGroups: { labelKey: MessageKey; items: ThemeDef[] }[] = [
    {
      labelKey: "settings.themeGroupSignature",
      items: THEMES.filter((th) => th.group === "signature"),
    },
    { labelKey: "settings.themeGroupModern", items: THEMES.filter((th) => th.group === "modern") },
    { labelKey: "settings.themeGroupRetro", items: THEMES.filter((th) => th.group === "retro") },
    { labelKey: "settings.themeGroupLight", items: THEMES.filter((th) => th.group === "light") },
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
</script>

<!-- Appearance -->
<section>
  <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionAppearance")}</h3>
  <div class="mb-2">
    <DisclosureRow variant="list" bind:open={themeOpen} testid="theme-toggle" label={t("settings.theme")}>
      {#snippet preview()}
        {#if currentTheme}
          <span class="flex shrink-0 overflow-hidden rounded border border-edge">
            {#each themeSwatches(currentTheme) as c, ci (ci)}
              <span class="h-3 w-2" style="background-color: {c}"></span>
            {/each}
          </span>
        {/if}
        <span class="truncate">{currentThemeName}</span>
      {/snippet}
    </DisclosureRow>
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
    <DisclosureRow variant="list" bind:open={fontOpen} testid="font-toggle" label={t("settings.font")}>
      {#snippet preview()}
        <span class="truncate">{currentFontLabel}</span>
      {/snippet}
    </DisclosureRow>
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
