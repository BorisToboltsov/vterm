<script lang="ts">
  // Unified collapsible-section header (Phase 15): leading chevron + label +
  // optional count, with an optional right-aligned value preview. Used by every
  // disclosure in the Settings panel so they look identical.
  import Icon from "./Icon.svelte";
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    label,
    count = null,
    testid = undefined,
    preview = undefined,
  }: {
    open?: boolean;
    label: string;
    count?: number | null;
    testid?: string;
    preview?: Snippet;
  } = $props();
</script>

<button
  type="button"
  data-testid={testid}
  aria-expanded={open}
  onclick={() => (open = !open)}
  class="flex w-full items-center gap-2 rounded text-xs text-muted hover:text-white"
>
  <Icon name={open ? "chevronDown" : "chevronRight"} size={14} class="shrink-0" />
  <span class="text-left">{label}</span>
  {#if count != null}
    <span class="shrink-0 text-muted">{count}</span>
  {/if}
  {#if preview}
    <span class="ml-auto flex min-w-0 items-center gap-2 text-white">{@render preview()}</span>
  {/if}
</button>
