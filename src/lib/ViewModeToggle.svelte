<script lang="ts">
  // Segmented Raw ↔ Table switch for the terminal pane's structured-log view.
  // Reused in two spots that are never visible at once: floating top-right over
  // the raw terminal (Terminal.svelte) and as the rightmost item of the table
  // toolbar (JsonLogView.svelte). Presentational — the parent owns the state.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";

  // `compact` collapses the labels to icons-only once the surrounding
  // `@container` toolbar is too narrow — set by JsonLogView; the floating
  // Terminal.svelte usage leaves it off and always shows the text.
  let {
    structured,
    onSelect,
    compact = false,
  }: {
    structured: boolean;
    onSelect: (structured: boolean) => void;
    compact?: boolean;
  } = $props();

  const labelCls = $derived(compact ? "@max-[460px]:hidden" : "");
</script>

<div
  role="group"
  aria-label={t("jsonlog.viewMode")}
  data-testid="view-mode-toggle"
  class="flex overflow-hidden rounded border border-edge bg-panel-alt text-xs shadow-sm"
>
  <button
    type="button"
    onclick={() => onSelect(false)}
    aria-pressed={!structured}
    use:tooltip={t("jsonlog.toggleRaw")}
    class="flex items-center gap-1 px-2 py-1 {!structured
      ? 'bg-edge text-text'
      : 'text-muted hover:text-accent'}"
  >
    <Icon name="terminal" size={13} />
    <span class={labelCls}>{t("jsonlog.viewRaw")}</span>
  </button>
  <button
    type="button"
    onclick={() => onSelect(true)}
    aria-pressed={structured}
    use:tooltip={t("jsonlog.toggleStructured")}
    class="flex items-center gap-1 px-2 py-1 {structured
      ? 'bg-edge text-accent'
      : 'text-muted hover:text-accent'}"
  >
    <Icon name="table" size={13} />
    <span class={labelCls}>{t("jsonlog.viewTable")}</span>
  </button>
</div>
