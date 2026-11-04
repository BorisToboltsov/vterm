<script lang="ts">
  // A list the filter narrowed to nothing (v1.29, ADR 0050). Not the list's own
  // empty state: «there is nothing» and «the filter hides all of it» are
  // different messages (ADR 0009) — this one says what narrows the list and
  // offers to drop it.
  import EmptyState from "./EmptyState.svelte";
  import { t } from "../i18n";

  let {
    summary,
    onreset,
    testid = "filtered-empty",
  }: {
    /** What narrows the list (`filterSummary`). */
    summary: string;
    onreset: () => void;
    testid?: string;
  } = $props();
</script>

<div class="h-full" data-testid={testid}>
  <EmptyState icon="filter" title={t("list.emptyTitle")} hint={summary}>
    <button
      type="button"
      class="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:bg-edge hover:text-text"
      data-testid="{testid}-reset"
      onclick={onreset}
    >
      {t("list.reset")}
    </button>
  </EmptyState>
</div>
