<script lang="ts">
  // The head of a monitoring section (v1.33): its name, what it is about, and the
  // question to the assistant when the assistant is on. Under it — the problems
  // filed under this section, the ones its dot in the navigation stands for: a dot
  // that leads to a page with nothing marked on it is no answer. The overview has
  // the whole list instead.
  import type { Snippet } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import MonProblemRow from "./MonProblemRow.svelte";
  import type { SectionId } from "./monproblems";
  import type { MonActions, MonView } from "./monsections";
  import { t } from "../i18n";

  let {
    section,
    v,
    a,
    title,
    sub = "",
    onask = undefined,
    askLabel = undefined,
    primary = false,
    children = undefined,
  }: {
    section: SectionId;
    v: Pick<MonView, "problems">;
    a: MonActions;
    title: string;
    sub?: string;
    onask?: () => void;
    askLabel?: string;
    /** The overview's one accent action. */
    primary?: boolean;
    children?: Snippet;
  } = $props();

  const mine = $derived(section === "overview" ? [] : v.problems.filter((p) => p.section === section));
</script>

<header class="mb-3 flex min-w-0 items-center gap-2">
  <h3 class="shrink-0 text-sm font-semibold text-text">{title}</h3>
  {#if sub}<span class="min-w-0 truncate text-xs text-muted">{sub}</span>{/if}
  <div class="ml-auto flex shrink-0 items-center gap-1.5">
    {@render children?.()}
    {#if onask}
      <button
        type="button"
        data-testid="mon-ask-ai"
        class="flex items-center gap-1 rounded px-2 py-1 text-meta {primary
          ? 'bg-accent text-panel-alt hover:bg-accent-hover'
          : 'border border-edge text-text hover:bg-edge'}"
        onclick={onask}
      >
        <Icon name="aiMark" size={13} />
        {askLabel ?? t("ai.ask.button")}
      </button>
    {/if}
  </div>
</header>

{#if mine.length}
  <ul
    aria-label={t("mon.attention")}
    class="mb-3 divide-y divide-edge/60 rounded-lg border px-3 {mine.some((p) => p.level === 'crit')
      ? 'border-bad/50 bg-bad/5'
      : 'border-warn/50 bg-warn/5'}"
    data-testid="mon-section-problems"
  >
    {#each mine as p (p.id)}
      <MonProblemRow {p} {a} />
    {/each}
  </ul>
{/if}
