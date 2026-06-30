<script lang="ts">
  // A KPI tile for the monitoring page header (Phase 13.1). Shows an icon+label,
  // then either a radial Gauge (bounded %) or a big threshold-coloured number,
  // plus an optional trend sparkline and a small sub-line. When `onclick` is set
  // the whole tile is a button (used to jump to the matching detail section).
  import Icon from "./Icon.svelte";
  import Gauge from "./Gauge.svelte";
  import Chart from "./Chart.svelte";
  import { levelTextClass, type ThresholdLevel } from "./thresholds";
  import type { IconName } from "./icons";

  let {
    icon,
    label,
    level = "ok",
    gaugeFill,
    gaugeText = "",
    big = "",
    sub = "",
    history,
    historyMax = 100,
    historyColor = "#22c55e",
    onclick,
    testid,
  }: {
    icon: IconName;
    label: string;
    level?: ThresholdLevel;
    /** When set (incl. null), render a Gauge instead of the big number. */
    gaugeFill?: number | null;
    gaugeText?: string;
    /** Big number, used when no gauge is given. */
    big?: string;
    /** Small secondary line under the visual. */
    sub?: string;
    /** Trend samples (already left-padded); omit to hide the sparkline. */
    history?: number[];
    historyMax?: number;
    historyColor?: string;
    onclick?: () => void;
    testid?: string;
  } = $props();

  const hasGauge = $derived(gaugeFill !== undefined);
  const cls =
    "flex w-full flex-col gap-2 rounded border border-edge bg-panel p-3 text-left";
</script>

{#snippet body()}
  <div class="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted">
    <Icon name={icon} size={13} />
    {label}
  </div>
  <div class="flex items-center gap-3">
    {#if hasGauge}
      <Gauge fill={gaugeFill ?? null} text={gaugeText} {level} />
    {:else}
      <span class="text-2xl font-semibold tabular-nums {levelTextClass(level)}">{big}</span>
    {/if}
    <div class="min-w-0 flex-1">
      {#if history}
        <Chart
          series={[{ values: history, color: historyColor, fill: true }]}
          max={historyMax}
          class="h-8 w-full"
        />
      {/if}
      {#if sub}
        <div class="mt-1 truncate text-[11px] text-muted" title={sub}>{sub}</div>
      {/if}
    </div>
  </div>
{/snippet}

{#if onclick}
  <button type="button" {onclick} data-testid={testid} class="{cls} hover:border-accent">
    {@render body()}
  </button>
{:else}
  <div data-testid={testid} class={cls}>{@render body()}</div>
{/if}
