<script lang="ts">
  // Pictogram + colour picker for a server profile (Phase 21). Two-way bound to
  // the form's `icon`/`color` keys. Collapsible: the disclosure header always
  // shows the current selection (glyph + name), so the choice stays visible even
  // when the grid is folded away. The set + resolvers are pure (servericons.ts).
  import Icon from "./Icon.svelte";
  import DisclosureRow from "./DisclosureRow.svelte";
  import InfoHint from "./InfoHint.svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    SERVER_ICONS,
    SERVER_COLORS,
    resolveServerIcon,
    resolveServerColorClass,
    resolveServerIconLabelKey,
  } from "./servericons";
  import { t } from "./i18n";

  let {
    icon = $bindable(""),
    color = $bindable(""),
    open = $bindable(false),
    label,
    hint = undefined,
  } = $props<{
    icon?: string;
    color?: string;
    open?: boolean;
    label: string;
    hint?: string;
  }>();
</script>

<div>
  <div class="flex items-center gap-1">
    <div class="min-w-0 flex-1">
      <DisclosureRow bind:open {label} testid="server-icon-section">
        {#snippet preview()}
          <span class="flex items-center gap-1.5" data-testid="server-icon-preview">
            <Icon name={resolveServerIcon(icon)} size={16} class={resolveServerColorClass(color)} />
            <span class="truncate text-meta text-muted">{t(resolveServerIconLabelKey(icon))}</span>
          </span>
        {/snippet}
      </DisclosureRow>
    </div>
    {#if hint}<InfoHint text={hint} />{/if}
  </div>

  {#if open}
    <!-- Glyph grid. -->
    <div class="mt-2 grid grid-cols-8 gap-1">
      {#each SERVER_ICONS as def (def.key)}
        <button
          type="button"
          class="flex aspect-square items-center justify-center rounded {icon === def.key
            ? 'border border-accent bg-accent/10 text-accent'
            : 'text-muted hover:bg-edge hover:text-white'}"
          data-testid={`server-icon-${def.key}`}
          use:tooltip={t(def.labelKey)}
          aria-label={t(def.labelKey)}
          aria-pressed={icon === def.key}
          onclick={() => (icon = def.key)}
        >
          <Icon name={def.icon} size={16} />
        </button>
      {/each}
    </div>

    <!-- Colour swatches ("muted" default first). -->
    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        class="h-5 w-5 rounded-full bg-muted {color === ''
          ? 'ring-2 ring-white/70 ring-offset-2 ring-offset-panel-alt'
          : ''}"
        data-testid="server-color-none"
        use:tooltip={t("serverColor.none")}
        aria-label={t("serverColor.none")}
        aria-pressed={color === ""}
        onclick={() => (color = "")}
      ></button>
      {#each SERVER_COLORS as c (c.key)}
        <button
          type="button"
          class="h-5 w-5 rounded-full {c.swatch} {color === c.key
            ? 'ring-2 ring-white/70 ring-offset-2 ring-offset-panel-alt'
            : ''}"
          data-testid={`server-color-${c.key}`}
          use:tooltip={t(c.labelKey)}
          aria-label={t(c.labelKey)}
          aria-pressed={color === c.key}
          onclick={() => (color = c.key)}
        ></button>
      {/each}
    </div>
  {/if}
</div>
