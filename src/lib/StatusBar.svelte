<script lang="ts">
  import { onDestroy } from "svelte";
  import { fetchMetrics, type Metrics } from "./api";
  import { diskFree as diskFreeOf, fmtBytes, memPct as memPctOf, osIconFor } from "./format";
  import { settings } from "./settings.svelte";
  import { isHidden } from "./util";
  import Icon from "./Icon.svelte";

  let { sessionId }: { sessionId: string } = $props();

  let metrics = $state<Metrics | null>(null);
  let failed = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  // Rolling history of CPU% samples for the mini sparkline (oldest → newest).
  const CPU_SAMPLES = 12;
  let cpuHistory = $state<number[]>([]);

  async function poll() {
    // Skip the network round-trip while the window is hidden — the values aren't
    // visible and polling a backgrounded app wastes a channel/CPU.
    if (isHidden()) return;
    try {
      const m = await fetchMetrics(sessionId);
      metrics = m;
      failed = false;
      if (m.cpuPct != null) {
        cpuHistory = [...cpuHistory, m.cpuPct].slice(-CPU_SAMPLES);
      }
    } catch {
      failed = true;
    }
  }

  // Poll again immediately when the window becomes visible.
  function onVisibility() {
    if (!isHidden()) poll();
  }

  // Restart polling whenever the active session or the interval changes.
  $effect(() => {
    const everyMs = Math.max(1, settings.statusPollInterval) * 1000;
    metrics = null;
    failed = false;
    cpuHistory = [];
    poll();
    clearInterval(timer);
    timer = setInterval(poll, everyMs);
    document.addEventListener("visibilitychange", onVisibility);
    void sessionId;
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  onDestroy(() => clearInterval(timer));

  const cpu = $derived(metrics?.cpuPct ?? null);
  // Left-pad with zeros so the chart keeps a stable width and fills from the right.
  const cpuBars = $derived([
    ...Array(Math.max(0, CPU_SAMPLES - cpuHistory.length)).fill(0),
    ...cpuHistory,
  ]);
  const loadTitle = $derived(
    metrics?.load1 != null
      ? `Load average: ${[metrics.load1, metrics.load5, metrics.load15]
          .filter((v) => v != null)
          .map((v) => (v as number).toFixed(2))
          .join(" ")}`
      : "CPU utilization",
  );
  const memPct = $derived(memPctOf(metrics?.memUsed ?? null, metrics?.memTotal ?? null));
  const diskFree = $derived(diskFreeOf(metrics?.diskUsed ?? null, metrics?.diskTotal ?? null));
</script>

<!--
  Status bar = groups of related metrics. Consistent spacing rules:
  • elements within a group are separated by `gap-2` (same for every group);
  • groups are marked off by a thin `divider()` in the text colour, with an equal
    `gap-2` on each side.
  Every value is `tabular-nums`; every icon is `size=14 text-muted`.
-->
{#snippet divider()}
  <span class="h-3 w-px shrink-0 bg-current" aria-hidden="true"></span>
{/snippet}
<div
  class="flex items-center gap-2 overflow-x-auto whitespace-nowrap border-t border-edge bg-panel-alt px-3 py-1 text-xs text-muted"
>
  {#if metrics}
    <span class="flex items-center gap-2">
      <Icon
        name={osIconFor(metrics)}
        size={14}
        class="text-muted"
        title={metrics.os || "Unknown OS"}
      />
      <span>{metrics.prettyName || metrics.os || "—"}</span>
    </span>
    {#if metrics.user || metrics.hostname}
      {@render divider()}
      <span>{metrics.user || "—"}@{metrics.hostname || "—"}</span>
    {/if}

    <!-- CPU: chip icon + sparkline + percent -->
    {@render divider()}
    <span class="flex items-center gap-2" title={loadTitle}>
      <Icon name="cpu" size={14} class="text-muted" />
      <span
        data-testid="cpu-chart"
        class="flex h-3.5 w-10 items-end gap-px overflow-hidden rounded-sm border border-edge bg-panel px-px"
      >
        {#each cpuBars as v, i (i)}
          <span
            class="min-w-0 flex-1 rounded-[1px]"
            style="height: {v > 0 ? Math.max(6, Math.min(100, v)) : 0}%; background-color: #22c55e"
          ></span>
        {/each}
      </span>
      <span class="tabular-nums">{cpu == null ? "—" : `${Math.round(cpu)}%`}</span>
    </span>

    <!-- RAM: memory-stick icon + value -->
    {@render divider()}
    <span class="flex items-center gap-2" title="RAM used / total">
      <Icon name="memory" size={14} class="text-muted" />
      <span class="tabular-nums"
        >{fmtBytes(metrics.memUsed)} / {fmtBytes(metrics.memTotal)}{memPct != null
          ? ` (${memPct}%)`
          : ""}</span
      >
    </span>

    <!-- Disk: HDD icon + value -->
    {@render divider()}
    <span class="flex items-center gap-2" title="Disk free / total on /">
      <Icon name="disk" size={14} class="text-muted" />
      <span class="tabular-nums"
        >{fmtBytes(diskFree)} free / {fmtBytes(metrics.diskTotal)}</span
      >
    </span>
  {:else if failed}
    <span>Metrics unavailable</span>
  {:else}
    <span>Loading metrics…</span>
  {/if}
</div>
