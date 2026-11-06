<script lang="ts">
  // One problem of monproblems.ts as a row: the overview's "Needs attention" list
  // and the strip under a section's head draw the same row, so a problem reads the
  // same wherever it is listed. The overview links the row to its section; the
  // section itself has nowhere to send it.
  import Icon from "../ui/Icon.svelte";
  import { SECTION_LABEL, type MonActions } from "./monsections";
  import type { Problem } from "./monproblems";
  import { t } from "../i18n";

  let { p, a, link = false }: { p: Problem; a: MonActions; link?: boolean } = $props();
</script>

<li class="flex items-center gap-2 py-1.5" data-testid="mon-problem" data-level={p.level}>
  <Icon name="alert" size={15} class="shrink-0 {p.level === 'crit' ? 'text-bad' : 'text-warn'}" />
  <div class="min-w-0 flex-1">
    <div class="truncate text-xs text-text">{t(p.key, p.params)}</div>
    {#if p.note}<div class="truncate font-mono text-meta text-muted">{p.note}</div>{/if}
  </div>
  {#if link}
    <button
      type="button"
      class="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text"
      onclick={() => a.go(p.section)}
    >
      {t(SECTION_LABEL[p.section])}
      <Icon name="arrowRight" size={11} />
    </button>
  {/if}
  {#if a.ask}
    <button
      type="button"
      aria-label={t("ai.ask.button")}
      class="shrink-0 rounded border border-edge px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text"
      onclick={() => a.ask?.({ kind: "problem", problem: p })}
    >
      <Icon name="aiMark" size={12} />
    </button>
  {/if}
</li>
