<script lang="ts">
  // Segmented Raw ↔ Table switch for the terminal pane's structured-log view.
  // Reused in two spots that are never visible at once: floating top-right over
  // the raw terminal (Terminal.svelte) and as the rightmost item of the table
  // toolbar (JsonLogView.svelte). Presentational — the parent owns the state.
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";

  let {
    structured,
    onSelect,
  }: { structured: boolean; onSelect: (structured: boolean) => void } = $props();
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
    title={t("jsonlog.toggleRaw")}
    class="flex items-center gap-1 px-2 py-1 {!structured
      ? 'bg-edge text-text'
      : 'text-muted hover:text-accent'}"
  >
    <Icon name="terminal" size={13} />
    {t("jsonlog.viewRaw")}
  </button>
  <button
    type="button"
    onclick={() => onSelect(true)}
    aria-pressed={structured}
    title={t("jsonlog.toggleStructured")}
    class="flex items-center gap-1 px-2 py-1 {structured
      ? 'bg-edge text-accent'
      : 'text-muted hover:text-accent'}"
  >
    <Icon name="table" size={13} />
    {t("jsonlog.viewTable")}
  </button>
</div>
