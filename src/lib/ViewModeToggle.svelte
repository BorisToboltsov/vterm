<script lang="ts">
  // Segmented Raw ↔ Table switch for the terminal pane's structured-log view.
  // Lives in the session bar under the server tabs (+page.svelte) — it used to
  // float over the terminal and covered the first row of full-screen programs.
  // Presentational — Terminal.svelte owns the state.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";

  // `compact` collapses the labels to icons-only once the surrounding
  // `@container` is too narrow (< 460px).
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
