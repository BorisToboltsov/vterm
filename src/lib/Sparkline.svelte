<script lang="ts">
  // Tiny bar sparkline: a fixed-width strip of bars filling from the right.
  // Pure presentational — the parent owns the (already padded) sample array.
  // Shared by the status-bar CPU chart and the monitoring overlay's history
  // charts, so the visual language stays identical (Phase «Расширение мониторинга»).
  let {
    values,
    max = 100,
    color = "#22c55e",
    testid,
    class: cls = "h-3.5 w-10",
  }: {
    /** Sample values, oldest → newest. Left-pad with zeros for a stable width. */
    values: number[];
    /** Value mapped to full height (defaults to 100 for percentages). */
    max?: number;
    /** Bar colour. */
    color?: string;
    testid?: string;
    /** Sizing classes for the container (height/width). */
    class?: string;
  } = $props();

  const scaled = $derived(
    values.map((v) => (max > 0 ? Math.min(100, Math.max(0, (v / max) * 100)) : 0)),
  );
</script>

<span
  data-testid={testid}
  class="flex items-end gap-px overflow-hidden rounded-sm border border-edge bg-panel px-px {cls}"
>
  {#each scaled as v, i (i)}
    <span
      class="min-w-0 flex-1 rounded-[1px]"
      style="height: {v > 0 ? Math.max(6, v) : 0}%; background-color: {color}"
    ></span>
  {/each}
</span>
