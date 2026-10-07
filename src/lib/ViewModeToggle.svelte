<script lang="ts">
  // Segmented two-way view switch. Born as the Raw ↔ Table switch of the
  // terminal pane's structured-log view (it lives in the session bar under the
  // server tabs — it used to float over the terminal and covered the first row of
  // full-screen programs), and since v1.5 also List ↔ Route in the k8s panel and
  // List ↔ Graph in the Docker one: the two sides are described by the caller,
  // the log view being the default. Presentational — the caller owns the state.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import type { IconName } from "./icons";
  import { t } from "./i18n";

  /** One side of the switch. */
  interface Side {
    icon: IconName;
    label: string;
    tooltip: string;
  }

  // `compact` collapses the labels to icons-only once the surrounding
  // `@container` is too narrow (< 460px).
  let {
    structured,
    onSelect,
    compact = false,
    label = undefined,
    off = undefined,
    on = undefined,
    testid = "view-mode-toggle",
  }: {
    structured: boolean;
    onSelect: (structured: boolean) => void;
    compact?: boolean;
    /** Accessible name of the group. */
    label?: string;
    /** The side shown while `structured` is false. */
    off?: Side;
    /** The side shown while `structured` is true. */
    on?: Side;
    testid?: string;
  } = $props();

  const labelCls = $derived(compact ? "@max-[460px]:hidden" : "");
  // Derived, not prop defaults: a default is computed once, and these have to
  // follow the interface language.
  const offSide = $derived<Side>(
    off ?? { icon: "terminal", label: t("jsonlog.viewRaw"), tooltip: t("jsonlog.toggleRaw") },
  );
  const onSide = $derived<Side>(
    on ?? { icon: "table", label: t("jsonlog.viewTable"), tooltip: t("jsonlog.toggleStructured") },
  );
</script>

<div
  role="group"
  aria-label={label ?? t("jsonlog.viewMode")}
  data-testid={testid}
  class="flex overflow-hidden rounded border border-edge bg-panel-alt text-xs shadow-sm"
>
  <button
    type="button"
    onclick={() => onSelect(false)}
    aria-pressed={!structured}
    use:tooltip={offSide.tooltip}
    class="flex items-center gap-1 px-2 py-1 {!structured
      ? 'bg-edge text-text'
      : 'text-muted hover:text-accent'}"
  >
    <Icon name={offSide.icon} size={13} />
    <span class={labelCls}>{offSide.label}</span>
  </button>
  <button
    type="button"
    onclick={() => onSelect(true)}
    aria-pressed={structured}
    use:tooltip={onSide.tooltip}
    class="flex items-center gap-1 px-2 py-1 {structured
      ? 'bg-edge text-accent'
      : 'text-muted hover:text-accent'}"
  >
    <Icon name={onSide.icon} size={13} />
    <span class={labelCls}>{onSide.label}</span>
  </button>
</div>
