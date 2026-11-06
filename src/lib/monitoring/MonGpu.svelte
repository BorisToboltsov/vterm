<script lang="ts">
  // The GPU section (v1.33): every NVIDIA GPU with utilization, memory,
  // temperature and power over the window, its clocks, and the processes using
  // it. Polled live while this section is on screen (`fetch_live_extras`).
  import Chart from "./Chart.svelte";
  import { SPARK } from "./chartgeom";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import { fmtMhz } from "./format";
  import { series } from "./monhistory";
  import type { MonActions, MonView } from "./monsections";
  import { SERIES } from "./monpalette";
  import { t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const gpus = $derived(v.live?.gpus ?? v.extras?.gpus ?? []);
  const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
</script>

<MonHeader
  section="gpu"
  {v}
  {a}
  title={t("mon.gpu")}
  sub={t("mon.gpusN", { n: gpus.length })}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "gpu" }) : undefined}
/>

{#each gpus as g, i (i)}
  <MonCard title={g.name} class="mb-2" testid="gpu-card">
    {#snippet aside()}
      <span class="tabular-nums">{t("mon.clocks", { sm: fmtMhz(g.clockSm), mem: fmtMhz(g.clockMem) })}</span>
    {/snippet}
    <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
      {#each [
        { label: t("mon.gpuUtil"), value: g.util, text: (n: number) => `${Math.round(n)}%`, key: `gpu.${i}.util`, color: SERIES.gpu, max: 100, sub: "" },
        { label: t("mon.vram"), value: g.memUsed, text: gib, key: `gpu.${i}.mem`, color: SERIES.vram, max: 100, sub: t("mon.ofTotal", { size: gib(g.memTotal) }) },
        { label: t("mon.temperature"), value: g.temp, text: (n: number) => `${Math.round(n)}°C`, key: `gpu.${i}.temp`, color: SERIES.temp, max: 100, sub: "" },
        { label: t("mon.power"), value: g.powerDraw, text: (n: number) => `${Math.round(n)} W`, key: `gpu.${i}.power`, color: SERIES.power, max: g.powerLimit ?? undefined, sub: g.powerLimit != null ? t("mon.ofTotal", { size: `${Math.round(g.powerLimit)} W` }) : "" },
      ] as tile (tile.key)}
        <div class="min-w-0 overflow-hidden rounded border border-edge pt-1.5">
          <div class="px-2">
            <div class="text-caption uppercase tracking-wider text-muted">{tile.label}</div>
            <TweenNumber value={tile.value} format={tile.text} class="text-sm font-semibold text-text" />
            <div class="truncate text-meta text-muted">{tile.sub || " "}</div>
          </div>
          <Chart lines={[{ samples: series(v.hist, tile.key), color: tile.color, fill: true }]} seq={v.seq} max={tile.max} slots={SPARK} height={30} />
        </div>
      {/each}
    </div>
    {#if g.procs.length}
      <table class="mt-2 w-full table-fixed text-meta">
        <thead>
          <tr class="text-left text-muted">
            <th class="w-16 font-medium">PID</th>
            <th class="font-medium">{t("mon.process")}</th>
            <th class="w-24 text-right font-medium">{t("mon.vram")}</th>
          </tr>
        </thead>
        <tbody>
          {#each g.procs as p (p.pid)}
            <tr class="border-t border-edge/40">
              <td class="py-0.5 tabular-nums text-muted">{p.pid}</td>
              <td class="truncate py-0.5 font-mono text-text">{p.name}</td>
              <td class="py-0.5 text-right tabular-nums">{p.memMib != null ? gib(p.memMib) : "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="mt-2 text-meta text-muted">{t("mon.gpuNoProcs")}</p>
    {/if}
  </MonCard>
{/each}
