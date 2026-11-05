<script lang="ts">
  // The CPU section (v1.33): where the time goes (user/system/iowait/steal) over
  // the window, load against the number of threads, queues and events, every
  // thread's own history, and the heaviest processes. Per-thread histories come
  // from the per-core reading every poll already takes.
  import Chart from "./Chart.svelte";
  import { SPARK } from "./chartgeom";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import Meter from "./Meter.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import { fmtAgo, fmtCount, fmtMhz, fmtPct } from "./format";
  import { keysOf, latest, peak, series } from "./monhistory";
  import type { MonActions, MonView } from "./monsections";
  import { SERIES } from "./monpalette";
  import { thresholdLevel, levelTextClass } from "./thresholds";
  import { t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const m = $derived(v.metrics);
  const d = $derived(v.detail);
  const hw = $derived(v.extras?.hardware ?? null);
  const cores = $derived(d?.perCpu ?? []);
  const threads = $derived(cores.length || m.cpuCount || 0);

  const sub = $derived(
    [
      hw?.cpuModel,
      hw?.cpuCores != null && hw?.cpuThreads != null
        ? t("mon.coresThreads", { c: hw.cpuCores, t: hw.cpuThreads })
        : threads
          ? t("mon.threadsN", { n: threads })
          : "",
      hw?.cpuMhz ? fmtMhz(hw.cpuMhz) : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );

  const parts = [
    { key: "brk.user", label: "mon.user", color: SERIES.user },
    { key: "brk.system", label: "mon.system", color: SERIES.system },
    { key: "brk.iowait", label: "mon.iowait", color: SERIES.iowait },
    { key: "brk.steal", label: "mon.steal", color: SERIES.steal },
  ] as const;
  const hasBreakdown = $derived(keysOf(v.hist, "brk.").length > 0);
  const top = $derived(peak(v.hist, "cpu"));
  const steal = $derived(latest(v.hist, "brk.steal"));
  const virt = $derived(hw?.virt && hw.virt !== "none" ? hw.virt : null);
  const freqs = $derived(d?.cpuFreqMhz ?? []);
  const throttled = $derived(
    d?.throttleCount != null && v.baseline?.throttle != null ? d.throttleCount - v.baseline.throttle : null,
  );
  const coreColor = (pct: number) => {
    const lv = thresholdLevel(pct, v.th.cpu);
    return lv === "crit" ? "var(--color-bad)" : lv === "warn" ? "var(--color-warn)" : SERIES.user;
  };
  const ago = (s: number) => {
    const secs = (v.seq - s) * v.interval;
    return secs <= 0 ? t("mon.now") : fmtAgo(secs);
  };
</script>

<MonHeader
  title={t("mon.cpu")}
  {sub}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "cpu" }) : undefined}
/>

<div class="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
  <TweenNumber value={m.cpuPct} format={fmtPct} class="text-2xl font-semibold {levelTextClass(thresholdLevel(m.cpuPct, v.th.cpu))}" />
  {#if top && top.v > (m.cpuPct ?? 0) + 5}
    <span class="text-xs text-muted">{t("mon.peakAt", { v: fmtPct(top.v), at: ago(top.s) })}</span>
  {/if}
  {#if hasBreakdown}
    <span class="ml-auto flex flex-wrap gap-x-3 text-meta text-muted">
      {#each parts as p (p.key)}
        <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-[2px]" style="background-color: {p.color}"></span>{t(p.label)}</span>
      {/each}
    </span>
  {/if}
</div>
{#if hasBreakdown}
  <Chart
    lines={parts.map((p) => ({ samples: series(v.hist, p.key), color: p.color }))}
    seq={v.seq}
    max={100}
    stacked
    ticks
    marks
    interval={v.interval}
    height={140}
    threshold={v.th.cpu.warn}
    thresholdLabel={v.th.cpu.warn != null ? t("mon.thresholdAt", { v: `${v.th.cpu.warn}%` }) : ""}
    testid="cpu-history"
  />
{:else}
  <Chart
    lines={[{ samples: series(v.hist, "cpu"), color: SERIES.cpu, fill: true }]}
    seq={v.seq}
    max={100}
    ticks
    marks
    interval={v.interval}
    height={140}
    testid="cpu-history"
  />
{/if}
{#if virt && steal != null && steal >= 0.5}
  <p class="mt-1 text-meta text-muted">{t("mon.stealNote", { v: steal.toFixed(1), virt })}</p>
{/if}

<div class="mt-3 grid gap-2 md:grid-cols-2">
  {#if m.load1 != null}
    <MonCard title={t("mon.loadHistory")}>
      {#snippet aside()}
        <span class="tabular-nums text-text">{m.load1?.toFixed(2)} · {m.load5?.toFixed(2) ?? "—"} · {m.load15?.toFixed(2) ?? "—"}</span>
      {/snippet}
      <Chart
        lines={[
          { samples: series(v.hist, "load1"), color: SERIES.load, fill: true },
          { samples: series(v.hist, "load5"), color: SERIES.load, width: 1 },
          { samples: series(v.hist, "load15"), color: SERIES.load, width: 0.75 },
        ]}
        seq={v.seq}
        max={threads ? Math.max(threads, Math.ceil(m.load1)) : undefined}
        threshold={threads || null}
        thresholdLabel={threads ? t("mon.threadsN", { n: threads }) : ""}
        height={70}
        testid="load-history"
      />
      <p class="mt-1 text-meta text-muted">{t("mon.loadNote")}</p>
    </MonCard>
  {/if}
  <MonCard title={t("mon.queues")}>
    <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
      {#if d?.psiCpu}
        <dt class="text-muted">{t("mon.psiWindows", { what: "CPU" })}</dt>
        <dd class="text-right tabular-nums">{d.psiCpu.avg10.toFixed(1)} / {d.psiCpu.avg60.toFixed(1)} / {d.psiCpu.avg300.toFixed(1)}</dd>
      {/if}
      {#if d?.procsRunning != null}
        <dt class="text-muted">{t("mon.readyBlocked")}</dt>
        <dd class="text-right tabular-nums">{d.procsRunning} / {d.procsBlocked ?? 0}</dd>
      {/if}
      <dt class="text-muted">{t("mon.ctxSwitch")}</dt>
      <dd class="text-right tabular-nums">
        {#if d?.ctxtRate != null}{fmtCount(d.ctxtRate)}{:else if v.loadingDelta}<Skeleton height="12px" width="44px" />{:else}—{/if}
      </dd>
      <dt class="text-muted">{t("mon.interrupts")}</dt>
      <dd class="text-right tabular-nums">
        {#if d?.intrRate != null}{fmtCount(d.intrRate)}{:else if v.loadingDelta}<Skeleton height="12px" width="44px" />{:else}—{/if}
      </dd>
      {#if m.load1 != null && threads}
        <dt class="text-muted">{t("mon.loadPerThread")}</dt>
        <dd class="text-right tabular-nums">{(m.load1 / threads).toFixed(2)}</dd>
      {/if}
      {#if freqs.length}
        <dt class="text-muted">{t("mon.freqNow")}</dt>
        <dd class="text-right tabular-nums">{fmtMhz(Math.min(...freqs))} – {fmtMhz(Math.max(...freqs))}</dd>
      {/if}
      {#if throttled != null}
        <dt class="text-muted">{t("mon.throttled")}</dt>
        <dd class="text-right tabular-nums {throttled > 0 ? 'text-warn' : ''}">{fmtCount(throttled)}</dd>
      {/if}
      {#if m.cpuTemp != null}
        <dt class="text-muted">{t("mon.temperature")}</dt>
        <dd class="text-right tabular-nums">{Math.round(m.cpuTemp)}°C</dd>
      {/if}
    </dl>
  </MonCard>
</div>

{#if cores.length}
  <div class="mt-3 mb-1.5 flex items-center justify-between">
    <h4 class="text-caption uppercase tracking-wider text-muted">{t("mon.threadsTitle", { n: cores.length })}</h4>
    <span class="text-meta text-muted">{t("mon.threadsNote")}</span>
  </div>
  <div class="grid grid-cols-4 gap-1.5 sm:grid-cols-8" data-testid="per-core">
    {#each cores as c, i (i)}
      <div class="min-w-0 rounded border border-edge bg-panel px-1.5 pt-1">
        <div class="flex justify-between text-meta">
          <span class="text-muted">{i}</span>
          <TweenNumber value={c} format={(n) => String(Math.round(n))} class={levelTextClass(thresholdLevel(c, v.th.cpu))} />
        </div>
        {#if freqs[i]}<div class="truncate text-caption text-muted">{fmtMhz(freqs[i])}</div>{/if}
        <Chart lines={[{ samples: series(v.hist, `core.${i}`), color: coreColor(c), fill: true, width: 1.2 }]} seq={v.seq} max={100} slots={SPARK} height={22} dot={false} />
      </div>
    {/each}
  </div>
{:else if v.loadingDelta}
  <div class="mt-3" data-testid="per-core-skeleton" aria-hidden="true"><Skeleton height="64px" /></div>
{/if}

{#if d?.topProcs.length}
  <MonCard title={t("mon.topProcs")} class="mt-3" testid="top-procs">
    {#snippet aside()}
      <button type="button" class="hover:text-text" onclick={() => a.go("processes")}>{t("mon.allProcesses")}</button>
    {/snippet}
    <table class="w-full table-fixed text-meta">
      <tbody>
        {#each d.topProcs as p (p.pid)}
          <tr class="border-t border-edge/40">
            <td class="w-14 py-1 tabular-nums text-muted">{p.pid}</td>
            <td class="truncate py-1 font-mono text-text">{p.comm}</td>
            <td class="w-20 truncate py-1 text-muted">{p.user}</td>
            <td class="w-36 py-1">
              <div class="flex items-center gap-2">
                <Meter pct={Math.min(100, p.cpu)} color={SERIES.cpu} class="h-1" />
                <span class="w-12 shrink-0 text-right tabular-nums">{p.cpu.toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </MonCard>
{/if}
