<script lang="ts">
  // "Logs & text" settings section (Phase 10): the smart-logs master toggle plus
  // per-feature switches, and the regex highlight-rules editor (add/remove/reorder,
  // colour from the active theme palette). Extracted from SettingsPanel.svelte in
  // Phase 18.5; reads/writes the settings store directly.
  import {
    settings,
    defaultHighlightRules,
    activeTerminalTheme,
    type HighlightColor,
  } from "./settings.svelte";
  import { tooltip } from "./actions/tooltip";
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import DisclosureRow from "./DisclosureRow.svelte";
  import { t } from "./i18n";
  import { slide } from "svelte/transition";
  import { motion, MOTION_BASE } from "./motion";

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
</script>

<!-- Logs & text (Phase 10) -->
<section>
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionSmartLogs")}<InfoHint text={t("settings.sectionSmartLogsHint")} />
  </h3>
  <label class="flex items-center gap-2 text-xs text-muted">
    <input type="checkbox" bind:checked={settings.smartLogs.enabled} />
    {t("settings.smartLogsAll")}
  </label>
  {#if settings.smartLogs.enabled}
    <div transition:slide={motion(MOTION_BASE)} class="mt-2 space-y-1.5">
      <DisclosureRow
        variant="list"
        bind:open={highlightRulesOpen}
        testid="highlight-rules-toggle"
        label={t("highlight.rulesSection")}
        count={settings.highlightRules.length}
      />

      {#if highlightRulesOpen}
        <div transition:slide={motion(MOTION_BASE)} class="mt-1 space-y-2">
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
                  use:tooltip={t("highlight.moveUp")}
                  aria-label={t("highlight.moveUp")}
                  class="rounded p-0.5 text-muted hover:text-accent disabled:opacity-30 disabled:hover:text-muted"
                >
                  <Icon name="chevronUp" size={13} />
                </button>
                <button
                  type="button"
                  onclick={() => moveRule(i, 1)}
                  disabled={i === settings.highlightRules.length - 1}
                  use:tooltip={t("highlight.moveDown")}
                  aria-label={t("highlight.moveDown")}
                  class="rounded p-0.5 text-muted hover:text-accent disabled:opacity-30 disabled:hover:text-muted"
                >
                  <Icon name="chevronDown" size={13} />
                </button>
                <button
                  type="button"
                  onclick={() => removeRule(rule.id)}
                  use:tooltip={t("highlight.deleteRule")}
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
                <p class="text-meta text-danger">{t("highlight.invalidPattern")}</p>
              {/if}
              <div class="flex items-center gap-1.5">
                {#each HIGHLIGHT_COLORS as c}
                  <button
                    type="button"
                    onclick={() => (rule.color = c)}
                    aria-label={t("highlight.color", { color: c })}
                    use:tooltip={t("highlight.color", { color: c })}
                    class="h-4 w-4 rounded-full border {rule.color === c
                      ? 'ring-2 ring-accent'
                      : 'border-edge'}"
                    style="background:{swatchColor(c)}"
                  ></button>
                {/each}
                <label class="ml-auto flex items-center gap-1 text-meta text-muted">
                  <input type="checkbox" bind:checked={rule.caseSensitive} />
                  {t("highlight.caseSensitive")}
                </label>
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted">
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
    </div>
  {/if}
</section>
