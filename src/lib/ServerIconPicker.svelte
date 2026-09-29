<script lang="ts">
  // Pictogram + colour picker for a server profile (Phase 21). Two-way bound to
  // the form's `icon`/`color` keys. Always unfolded — it already sits inside the
  // form's collapsible "Appearance & tags" section, and a second fold only hid the
  // choice. The set + resolvers are pure (servericons.ts).
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import { tooltip } from "./actions/tooltip";
  import { SERVER_ICONS, SERVER_COLORS } from "./servericons";
  import { t } from "./i18n";

  let {
    icon = $bindable(""),
    color = $bindable(""),
    label,
    hint = undefined,
  } = $props<{
    icon?: string;
    color?: string;
    label: string;
    hint?: string;
  }>();
</script>

<div>
  <div class="flex items-center gap-1 text-xs text-muted">
    {label}
    {#if hint}<InfoHint text={hint} />{/if}
  </div>

  <!-- Glyph grid. -->
  <div class="mt-2 grid grid-cols-8 gap-1">
    {#each SERVER_ICONS as def (def.key)}
      <button
        type="button"
        class="flex aspect-square items-center justify-center rounded {icon === def.key
          ? 'border border-accent bg-accent/10 text-accent'
          : 'text-muted hover:bg-edge hover:text-text'}"
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
        ? 'ring-2 ring-accent ring-offset-2 ring-offset-panel-alt'
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
          ? 'ring-2 ring-accent ring-offset-2 ring-offset-panel-alt'
          : ''}"
        data-testid={`server-color-${c.key}`}
        use:tooltip={t(c.labelKey)}
        aria-label={t(c.labelKey)}
        aria-pressed={color === c.key}
        onclick={() => (color = c.key)}
      ></button>
    {/each}
  </div>
</div>
