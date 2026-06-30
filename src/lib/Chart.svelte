<script lang="ts">
  // Area / line chart for monitoring histories (Phase 13.2). One or more series
  // share a y-scale; any series can be area-filled. SVG sized by the container
  // class (viewBox is stretched, strokes stay crisp via non-scaling-stroke).
  // Pure presentational — the parent owns the sample arrays. The status-bar
  // bar-sparkline ([Sparkline.svelte]) is a separate, pinned visual.
  type Series = { values: number[]; color: string; fill?: boolean };

  let {
    series,
    max,
    class: cls = "h-10 w-full",
    testid,
  }: {
    series: Series[];
    /** Shared full-scale value; omit to auto-scale to the data (min 1). */
    max?: number;
    class?: string;
    testid?: string;
  } = $props();

  const W = 100;
  const H = 32;
  const scale = $derived(Math.max(1, max ?? Math.max(1, ...series.flatMap((s) => s.values))));

  function xy(values: number[]): [number, number][] {
    const n = values.length;
    return values.map((v, i) => {
      const x = n <= 1 ? W : (i / (n - 1)) * W;
      const y = H - Math.min(1, Math.max(0, v / scale)) * H;
      return [x, y];
    });
  }
  function line(values: number[]): string {
    return xy(values)
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(" ");
  }
  function area(values: number[]): string {
    if (values.length < 2) return "";
    return `M0,${H} ${xy(values)
      .map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`)
      .join(" ")} L${W},${H} Z`;
  }
</script>

<svg
  viewBox="0 0 {W} {H}"
  preserveAspectRatio="none"
  data-testid={testid}
  class="rounded-sm border border-edge bg-panel {cls}"
  role="img"
  aria-hidden="true"
>
  {#each series as s, i (i)}
    {#if s.fill && s.values.length >= 2}
      <path d={area(s.values)} fill={s.color} fill-opacity="0.18" stroke="none" />
    {/if}
    {#if s.values.length > 0}
      <path
        d={line(s.values)}
        fill="none"
        stroke={s.color}
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    {/if}
  {/each}
</svg>
