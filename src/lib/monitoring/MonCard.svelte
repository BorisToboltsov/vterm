<script lang="ts">
  // A block of a monitoring section (v1.33): a titled panel. Pure presentational.
  import type { Snippet } from "svelte";

  let {
    title = "",
    aside = undefined,
    children,
    class: cls = "",
    tone = "plain",
    pad = true,
    testid = undefined,
  }: {
    title?: string;
    aside?: Snippet;
    children: Snippet;
    class?: string;
    /** A border that says the block holds a problem. */
    tone?: "plain" | "warn" | "crit";
    /** Inner padding; a list that runs edge to edge has none. */
    pad?: boolean;
    testid?: string;
  } = $props();

  const border = $derived(tone === "crit" ? "border-bad/50" : tone === "warn" ? "border-warn/50" : "border-edge");
</script>

<section class="min-w-0 overflow-hidden rounded-lg border bg-panel {pad ? 'p-3' : ''} {border} {cls}" data-testid={testid}>
  {#if title || aside}
    <div class="mb-2 flex items-center justify-between gap-2">
      {#if title}<h4 class="shrink-0 text-caption uppercase tracking-wider text-muted">{title}</h4>{/if}
      {#if aside}<div class="min-w-0 truncate text-meta text-muted">{@render aside()}</div>{/if}
    </div>
  {/if}
  {@render children()}
</section>
