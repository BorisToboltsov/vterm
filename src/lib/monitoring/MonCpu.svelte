<script lang="ts">
  // The CPU section (v1.33): where the time goes (user/system/iowait/steal) over
  // the window, load against the number of threads, queues and events, every
  // thread's own history, and the heaviest processes. Per-thread histories come
  // from the per-core reading every poll already takes.
  //
  // The load chart scales to its window, not to the newest reading, so an earlier
  // peak is not cut at the ceiling; where load turns warn and crit is shaded behind
  // the lines from `loadZones` — the bounds the list of problems judges by.
  //
  // Every block runs the full width, so no block stands beside a shorter one and
  // leaves a hole: the load chart sits under the CPU chart on the same time axis,
  // queues and events are one row of figures, and the threads' grid takes as many
  // columns as gives even rows (`evenColumns`). One thread has no grid — its only
  // tile would be the CPU chart again.
  import Chart from "./Chart.svelte";
  import { SPARK } from "./chartgeom";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import Meter from "./Meter.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import { evenColumns } from "../ui/util";
  import { fmtAgo, fmtCount, fmtLoad, fmtMhz, fmtPct } from "./format";
  import { loadZones } from "./monhealth";
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
  const zones = $derived(loadZones(threads, v.th.load));
  const loadLevel = $derived(v.problems.find((p) => p.id === "load")?.level ?? "ok");
  const loadLimit = $derived(loadLevel === "crit" ? zones.crit : loadLevel === "warn" ? zones.warn : null);
  const loads = [
    { key: "load1", label: "mon.load1m", color: SERIES.load1, fill: true, width: 1.6, dashed: false },
    { key: "load5", label: "mon.load5m", color: SERIES.load5, fill: false, width: 1.2, dashed: false },
    { key: "load15", label: "mon.load15m", color: SERIES.load15, fill: false, width: 1.2, dashed: true },
  ] as const;
  type Fact = { id: string; label: string; value: string | null; cls?: string };
  // Queues and events: what the host reported, nothing for what it did not; a rate
  // that needs a second poll is a skeleton until then.
  const facts = $derived.by((): Fact[] => {
    const out: Fact[] = [];
    if (d?.psiCpu) {
      const p = d.psiCpu;
      out.push({ id: "psi", label: t("mon.psiWindows", { what: "CPU" }), value: `${p.avg10.toFixed(1)} / ${p.avg60.toFixed(1)} / ${p.avg300.toFixed(1)}` });
    }
    if (d?.procsRunning != null) out.push({ id: "ready", label: t("mon.readyBlocked"), value: `${d.procsRunning} / ${d.procsBlocked ?? 0}` });
    out.push({ id: "ctxt", label: t("mon.ctxSwitch"), value: d?.ctxtRate != null ? fmtCount(d.ctxtRate) : null });
    out.push({ id: "intr", label: t("mon.interrupts"), value: d?.intrRate != null ? fmtCount(d.intrRate) : null });
    if (freqs.length) out.push({ id: "freq", label: t("mon.freqNow"), value: `${fmtMhz(Math.min(...freqs))} – ${fmtMhz(Math.max(...freqs))}` });
    if (throttled != null) out.push({ id: "throttled", label: t("mon.throttled"), value: fmtCount(throttled), cls: throttled > 0 ? "text-warn" : "" });
    if (m.cpuTemp != null) out.push({ id: "temp", label: t("mon.temperature"), value: `${Math.round(m.cpuTemp)}°C` });
    return out;
  });
  const ago = (s: number) => {
    const secs = (v.seq - s) * v.interval;
    return secs <= 0 ? t("mon.now") : fmtAgo(secs);
  };
</script>

<MonHeader
  section="cpu"
  {v}
  {a}
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

{#if m.load1 != null}
  <MonCard title={t("mon.loadHistory")} tone={loadLevel === "ok" ? "plain" : loadLevel} class="mt-3" testid="load-card">
    {#snippet aside()}
      {#if threads}
        {t("mon.threadsN", { n: threads })} · {t("mon.perThread")}
        <span class="tabular-nums {levelTextClass(loadLevel) || 'text-text'}" data-testid="load-per-thread" data-level={loadLevel}
          >{((m.load1 ?? 0) / threads).toFixed(2)}</span
        >
        {#if loadLimit != null}<span>{t("mon.thresholdAt", { v: fmtLoad(loadLimit / threads) })}</span>{/if}
      {/if}
    {/snippet}
    <div class="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 text-meta text-muted" data-testid="load-legend">
      {#each loads as l (l.key)}
        <span class="flex items-center gap-1">
          <span
            class="w-2.5 {l.dashed ? 'border-t border-dashed' : 'h-0.5 rounded-full'}"
            style={l.dashed ? `border-color: ${l.color}` : `background-color: ${l.color}`}
          ></span>
          {t(l.label)}
          <span class="tabular-nums text-text">{m[l.key]?.toFixed(2) ?? "—"}</span>
        </span>
      {/each}
      <span class="ml-auto flex flex-wrap gap-x-3">
        {#if zones.warn != null}
          <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-[2px] bg-warn/40"></span>{t("mon.zoneWarn", { v: fmtLoad(zones.warn) })}</span>
        {/if}
        {#if zones.crit != null}
          <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-[2px] bg-bad/40"></span>{t("mon.zoneCrit", { v: fmtLoad(zones.crit) })}</span>
        {/if}
      </span>
    </div>
    <Chart
      lines={loads.map((l) => ({ samples: series(v.hist, l.key), color: l.color, fill: l.fill, width: l.width, dashed: l.dashed }))}
      seq={v.seq}
      zones={[
        ...(zones.warn != null ? [{ from: zones.warn, to: zones.crit, color: "var(--color-warn)" }] : []),
        ...(zones.crit != null ? [{ from: zones.crit, color: "var(--color-bad)" }] : []),
      ]}
      ticks
      marks
      format={fmtLoad}
      interval={v.interval}
      height={110}
      testid="load-history"
    />
  </MonCard>
{/if}

<MonCard title={t("mon.queues")} class="mt-2" testid="cpu-queues">
  <dl class="grid gap-x-4 gap-y-2" style="grid-template-columns: repeat({evenColumns(facts.length, 5)}, minmax(0, 1fr))">
    {#each facts as f (f.id)}
      <div class="min-w-0" data-testid="fact-{f.id}">
        <dt class="truncate text-meta text-muted">{f.label}</dt>
        <dd class="text-sm tabular-nums {f.cls ?? ''}">
          {#if f.value != null}{f.value}{:else if v.loadingDelta}<Skeleton height="14px" width="44px" />{:else}—{/if}
        </dd>
      </div>
    {/each}
  </dl>
</MonCard>

{#if cores.length > 1}
  <div class="mt-3 mb-1.5 flex items-center justify-between">
    <h4 class="text-caption uppercase tracking-wider text-muted">{t("mon.threadsTitle", { n: cores.length })}</h4>
    <span class="text-meta text-muted">{t("mon.threadsNote")}</span>
  </div>
  <div class="grid gap-1.5" style="grid-template-columns: repeat({evenColumns(cores.length, 8)}, minmax(0, 1fr))" data-testid="per-core">
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
{:else if v.loadingDelta && threads > 1}
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
