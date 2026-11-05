<script lang="ts">
  // The head of a monitoring section (v1.33): its name, what it is about, and the
  // question to the assistant when the assistant is on.
  import type { Snippet } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import { t } from "../i18n";

  let {
    title,
    sub = "",
    onask = undefined,
    askLabel = undefined,
    primary = false,
    children = undefined,
  }: {
    title: string;
    sub?: string;
    onask?: () => void;
    askLabel?: string;
    /** The overview's one accent action. */
    primary?: boolean;
    children?: Snippet;
  } = $props();
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
