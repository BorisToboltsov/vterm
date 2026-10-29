<script lang="ts">
  // Horizontal composite bar with an optional legend (Phase 13.2). Segments are
  // sized proportionally to their value; used for memory composition, TCP states,
  // package updates, etc. Pure presentational — the parent supplies the segments.
  type Segment = { label: string; value: number; color: string };

  let {
    segments,
    legend = true,
    class: cls = "",
    testid,
  }: {
    segments: Segment[];
    legend?: boolean;
    class?: string;
    testid?: string;
  } = $props();

  const total = $derived(Math.max(1, segments.reduce((s, x) => s + Math.max(0, x.value), 0)));
</script>

<div data-testid={testid} class={cls}>
  <div class="flex h-2.5 w-full overflow-hidden rounded-full bg-edge">
    {#each segments as s, i (i)}
      {#if s.value > 0}
        <span
          class="block h-full"
          style="width: {(s.value / total) * 100}%; background-color: {s.color}"
          title="{s.label}: {Math.round((s.value / total) * 100)}%"
        ></span>
      {/if}
    {/each}
  </div>
  {#if legend}
    <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted">
      {#each segments as s, i (i)}
        <span class="flex items-center gap-1">
          <span
            class="inline-block h-2 w-2 shrink-0 rounded-[2px]"
            style="background-color: {s.color}"
          ></span>
          {s.label}
        </span>
      {/each}
    </div>
  {/if}
</div>
