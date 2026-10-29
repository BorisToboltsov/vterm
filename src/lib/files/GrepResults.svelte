<script lang="ts">
  // The results of a content search (v1.17): how many, in how many files, and the
  // matching lines grouped under the file they are in, with what was searched for
  // marked. Says what the answer is not: that it was cut at the limit, that some
  // files could not be read, that the search did not run at all — an empty list
  // under a search that failed read as "no matches".
  //
  // The content only: a wide file panel shows it in the pane beside the listing,
  // a narrow one in the box under the search field. It owns no dialog.
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { groupMatches, lineSpans } from "./grepview";
  import type { GrepMatch, GrepOutcome } from "../sync/sync";
  import { t } from "../i18n";

  let {
    outcome,
    query,
    caseSensitive = false,
    regex = false,
    limit,
    fill = false,
    onopen,
  }: {
    outcome: GrepOutcome;
    /** What was searched for — marked in the lines. */
    query: string;
    caseSensitive?: boolean;
    regex?: boolean;
    /** The most matches a search returns — named when the answer was cut at it. */
    limit: number;
    /** Take the height of the place it stands in (a pane) and scroll there. */
    fill?: boolean;
    onopen: (match: GrepMatch) => void;
  } = $props();

  const groups = $derived(groupMatches(outcome.matches));
  const opts = $derived({ caseSensitive, regex });
</script>

<div
  class="flex flex-col text-meta {fill ? 'min-h-0 flex-1' : ''}"
  data-testid="grep-results"
>
  {#if outcome.failed && outcome.matches.length === 0}
    <!-- Not "no matches": the search did not run. -->
    <p class="flex items-start gap-1 py-1 text-bad" data-testid="grep-failed">
      <Icon name="alert" size={12} class="mt-0.5 shrink-0" />{t("search.failed")}
    </p>
  {:else if outcome.matches.length === 0}
    <p class="py-1 text-muted" data-testid="grep-empty">{t("search.noResults")}</p>
  {:else}
    <p class="pb-1 text-muted" data-testid="grep-summary">
      {t("search.summary", { matches: outcome.matches.length, files: groups.length })}
    </p>
    {#if outcome.truncated}
      <p class="flex items-start gap-1 pb-1 text-warn" data-testid="grep-truncated">
        <Icon name="alert" size={12} class="mt-0.5 shrink-0" />{t("search.truncated", { limit })}
      </p>
    {/if}
    {#if outcome.failed}
      <p class="flex items-start gap-1 pb-1 text-warn" data-testid="grep-partial">
        <Icon name="alert" size={12} class="mt-0.5 shrink-0" />{t("search.partial")}
      </p>
    {/if}
    <div
      class="overflow-auto rounded border border-edge {fill ? 'min-h-0 flex-1' : 'max-h-48'}"
      data-testid="grep-list"
    >
      {#each groups as g (g.path)}
        <button
          type="button"
          class="sticky top-0 flex w-full items-center gap-1.5 bg-panel-alt px-2 py-1 text-left hover:bg-edge"
          data-testid="grep-file"
          use:tooltip={g.path}
          onclick={() => onopen(g.matches[0])}
        >
          <Icon name="file" size={12} class="shrink-0 text-accent" />
          <span class="min-w-0 truncate text-accent">{g.path}</span>
          <span class="shrink-0 text-muted">· {g.matches.length}</span>
        </button>
        {#each g.matches as m (m.line)}
          <button
            type="button"
            class="flex w-full items-baseline gap-2 px-2 py-0.5 text-left hover:bg-edge"
            data-testid="grep-line"
            onclick={() => onopen(m)}
          >
            <span class="w-8 shrink-0 text-right tabular-nums text-muted">{m.line}</span>
            <span class="min-w-0 truncate font-mono text-text/80"
              >{#each lineSpans(m.text, query, opts) as span, i (i)}{#if span.hit}<mark
                    class="rounded-sm bg-warn/25 text-text">{span.text}</mark
                  >{:else}{span.text}{/if}{/each}</span
            >
          </button>
        {/each}
      {/each}
    </div>
  {/if}
</div>
