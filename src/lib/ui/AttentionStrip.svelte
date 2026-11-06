<script lang="ts" module>
  /** One row of the strip. */
  export interface AttentionItem {
    key: string;
    name: string;
    tone: "warn" | "bad";
    /** Why, in words. */
    reason: string;
    /** The figure that says it (`exit 1`, `↻+2`). */
    detail?: string;
  }
</script>

<script lang="ts">
  // «Needs attention» above a dock list (v1.33): the containers or pods that are
  // failing, restarting, stuck — named in one place instead of found by reading
  // every dot of the list. A row is a button: it opens that item's details. The
  // strip folds to its title; with nothing to report it is not drawn at all.
  // Presentational — what needs a look is decided by the panel's pure model
  // (`dockerAttention`, `podAttention`).
  import Icon from "./Icon.svelte";
  import { t } from "../i18n";

  let {
    items,
    open = $bindable(true),
    onpick,
    testid = "attention",
  }: {
    items: readonly AttentionItem[];
    open?: boolean;
    onpick: (key: string) => void;
    testid?: string;
  } = $props();

  const worst = $derived(items.some((i) => i.tone === "bad") ? "bad" : "warn");
  const DOT: Record<string, string> = { warn: "bg-warn", bad: "bg-bad" };
  const TEXT: Record<string, string> = { warn: "text-warn", bad: "text-bad" };
</script>

{#if items.length > 0}
  <div class="shrink-0 border-b border-edge" data-testid={testid} data-morph>
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-meta hover:bg-edge/30 {TEXT[worst]}"
      aria-expanded={open}
      data-testid="{testid}-toggle"
      onclick={() => (open = !open)}
    >
      <Icon name={open ? "chevronDown" : "chevronRight"} size={11} class="shrink-0" />
      <Icon name="alert" size={12} class="shrink-0" />
      <span class="min-w-0 truncate">{t("attention.title", { n: items.length })}</span>
    </button>
    {#if open}
      <ul class="max-h-[7.5rem] overflow-y-auto pb-1" data-testid="{testid}-list">
        {#each items as item (`${item.key}|${item.reason}`)}
          <li>
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 py-0.5 pl-6 pr-2 text-left text-meta hover:bg-edge/30"
              data-testid="{testid}-item"
              onclick={() => onpick(item.key)}
            >
              <span class="h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full {DOT[item.tone]}"></span>
              <span class="min-w-0 max-w-[45%] shrink-0 truncate text-text/90">{item.name}</span>
              <span class="min-w-0 flex-1 truncate text-muted">{item.reason}</span>
              {#if item.detail}
                <span class="shrink-0 tabular-nums {TEXT[item.tone]}">{item.detail}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
