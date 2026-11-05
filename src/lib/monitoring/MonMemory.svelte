<script lang="ts">
  // The Memory section (v1.33): used, cache and free over the window, what the
  // memory is made of, swap and its traffic, how much tasks wait for memory
  // (PSI), what the OOM killer did, and the processes holding the most.
  import Chart from "./Chart.svelte";
  import { SPARK } from "./chartgeom";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import Meter from "./Meter.svelte";
  import StackedBar from "./StackedBar.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import Icon from "../ui/Icon.svelte";
  import { fmtBytes, fmtPct, fmtRate, memPct } from "./format";
  import { series } from "./monhistory";
  import type { MonActions, MonView } from "./monsections";
  import { SERIES } from "./monpalette";
  import { thresholdLevel, levelTextClass } from "./thresholds";
  import { currentLocale, t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const m = $derived(v.metrics);
  const d = $derived(v.detail);
  const x = $derived(v.extras);
  const ram = $derived(memPct(m.memUsed, m.memTotal));
  const swap = $derived(m.swapTotal ? memPct(m.swapUsed, m.swapTotal) : null);
  const hasSplit = $derived(d?.memFree != null && d?.memTotal != null);
  const oomProblem = $derived(v.problems.find((p) => p.id === "oom") ?? null);
  const gib = (n: number) => (n <= 0 ? "0" : `${+(n / 1024 ** 3).toFixed(1)}G`);
  const when = (o: { at: string | null; bootSecs: number | null }) =>
    o.at
      ? new Date(o.at).toLocaleString(currentLocale())
      : o.bootSecs != null
        ? t("mon.afterBoot", { h: (o.bootSecs / 3600).toFixed(1) })
        : "—";
</script>

<MonHeader
  title={t("mon.memory")}
  sub={[fmtBytes(m.memTotal), m.swapTotal ? t("mon.swapOf", { size: fmtBytes(m.swapTotal) }) : ""].filter(Boolean).join(" · ")}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "memory" }) : undefined}
/>

<div class="mb-1 flex flex-wrap items-baseline gap-x-3">
  <TweenNumber value={ram} format={fmtPct} class="text-2xl font-semibold {levelTextClass(thresholdLevel(ram, v.th.ram))}" />
  <span class="text-xs text-muted">
    {t("mon.usedAmount", { size: fmtBytes(m.memUsed) })}
    {#if d?.memAvailable != null} · {t("mon.availableAmount", { size: fmtBytes(d.memAvailable) })}{/if}
  </span>
</div>
{#if hasSplit && m.memTotal}
  <Chart
    lines={[
      { samples: series(v.hist, "mem.used"), color: SERIES.ram },
      { samples: series(v.hist, "mem.cache"), color: SERIES.cache },
      { samples: series(v.hist, "mem.free"), color: "var(--color-edge)" },
    ]}
    seq={v.seq}
    max={m.memTotal}
    stacked
    total={false}
    ticks
    format={gib}
    marks
    interval={v.interval}
    height={124}
    testid="mem-history"
  />
  <StackedBar
    class="mt-3"
    testid="mem-composition"
    segments={[
      { label: t("mon.used"), value: m.memUsed ?? 0, color: SERIES.ram, text: fmtBytes(m.memUsed) },
      { label: t("mon.cache"), value: d!.memCached ?? 0, color: SERIES.cache, text: fmtBytes(d!.memCached) },
      { label: t("mon.buffers"), value: d!.memBuffers ?? 0, color: SERIES.swap, text: fmtBytes(d!.memBuffers) },
      { label: t("mon.free"), value: d!.memFree ?? 0, color: "var(--color-edge)", text: fmtBytes(d!.memFree) },
    ]}
  />
  <p class="mt-1 text-meta text-muted">{t("mon.availableNote")}</p>
{:else}
  <Chart
    lines={[{ samples: series(v.hist, "ram"), color: SERIES.ram, fill: true }]}
    seq={v.seq}
    max={100}
    ticks
    marks
    interval={v.interval}
    height={124}
    testid="mem-history"
  />
{/if}

<div class="mt-3 grid gap-2 md:grid-cols-3">
  <MonCard title={t("mon.swap")}>
    {#if m.swapTotal}
      <div class="flex items-baseline justify-between">
        <span class="text-sm tabular-nums">{fmtBytes(m.swapUsed)} <span class="text-meta text-muted">/ {fmtBytes(m.swapTotal)}</span></span>
        <TweenNumber value={swap} format={fmtPct} class="text-xs {levelTextClass(thresholdLevel(swap, v.th.swap))}" />
      </div>
      <Chart lines={[{ samples: series(v.hist, "swap"), color: SERIES.swap, fill: true }]} seq={v.seq} max={100} slots={SPARK} height={26} class="my-1" />
      {#if d?.swapInRate != null || d?.swapOutRate != null}
        <p class="text-meta text-muted">{t("mon.swapTraffic", { in: fmtRate(d?.swapInRate ?? null), out: fmtRate(d?.swapOutRate ?? null) })}</p>
      {/if}
    {:else}
      <p class="text-meta text-muted">{t("mon.noSwap")}</p>
    {/if}
  </MonCard>
  <MonCard title={t("mon.psiMemory")}>
    {#if d?.psiMem}
      <div class="text-sm tabular-nums">
        {d.psiMem.avg10.toFixed(1)}
        <span class="text-meta text-muted">/ {d.psiMem.avg60.toFixed(1)} / {d.psiMem.avg300.toFixed(1)}</span>
      </div>
      <Chart lines={[{ samples: series(v.hist, "psiMem"), color: SERIES.ram, fill: true }]} seq={v.seq} floor={1} slots={SPARK} height={26} class="my-1" />
      <p class="text-meta text-muted">{t("mon.psiMemHint")}</p>
    {:else}
      <p class="text-meta text-muted">{t("mon.psiNone")}</p>
    {/if}
  </MonCard>
  <MonCard title={t("mon.oomKiller")} tone={oomProblem ? "crit" : "plain"} testid="oom-card">
    {#if x == null}
      <p class="text-meta text-muted">{t("mon.collecting")}</p>
    {:else if x.oomKills == null}
      <p class="text-meta text-muted">{t("mon.oomUnknown")}</p>
    {:else}
      <div class="text-sm tabular-nums {x.oomKills > 0 ? 'text-bad' : ''}">
        {x.oomKills} <span class="text-meta text-muted">{t("mon.thisBoot")}</span>
      </div>
      {#if x.oomVictims.length}
        <ul class="mt-1 space-y-0.5 text-meta">
          {#each [...x.oomVictims].reverse().slice(0, 5) as o, i (i)}
            <li class="flex justify-between gap-2">
              <span class="truncate font-mono text-text">{o.name}{o.pid != null ? ` (${o.pid})` : ""}</span>
              <span class="shrink-0 text-muted">{when(o)}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if oomProblem && a.ask}
        <button
          type="button"
          class="mt-2 flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta hover:bg-edge"
          onclick={() => a.ask?.({ kind: "problem", problem: oomProblem })}
        >
          <Icon name="aiMark" size={12} />
          {t("mon.askWhy")}
        </button>
      {/if}
    {/if}
  </MonCard>
</div>

{#if d?.topMemProcs.length}
  <MonCard title={t("mon.topMemProcs")} class="mt-3" testid="top-mem">
    {#snippet aside()}<span>{t("mon.sizeNote")}</span>{/snippet}
    <table class="w-full table-fixed text-meta">
      <tbody>
        {#each d.topMemProcs as p (p.pid)}
          <tr class="border-t border-edge/40">
            <td class="w-14 py-1 tabular-nums text-muted">{p.pid}</td>
            <td class="truncate py-1 font-mono text-text">{p.comm}</td>
            <td class="w-20 py-1 text-right tabular-nums text-muted">{m.memTotal ? fmtBytes((p.mem / 100) * m.memTotal) : "—"}</td>
            <td class="w-36 py-1 pl-3">
              <div class="flex items-center gap-2">
                <Meter pct={p.mem} color={SERIES.ram} class="h-1" />
                <span class="w-12 shrink-0 text-right tabular-nums">{p.mem.toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </MonCard>
{/if}
