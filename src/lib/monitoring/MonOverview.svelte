<script lang="ts">
  // The first screen of the monitoring page (v1.33): what needs attention, the
  // four resources at a glance, how much tasks wait for them (PSI), who uses them
  // most, and the host. The list of problems is monproblems.ts — the same list
  // that colours the navigation, so the two never disagree.
  import Icon from "../ui/Icon.svelte";
  import Chart from "./Chart.svelte";
  import { SPARK } from "./chartgeom";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import { fmtBytes, fmtPct, fmtRate, fmtUptime, memPct } from "./format";
  import { series } from "./monhistory";
  import { fullestPartition, SECTION_LABEL, type MonActions, type MonView } from "./monsections";
  import type { DiskDev, NetIface } from "../api";
  import { SERIES } from "./monpalette";
  import { thresholdLevel, levelTextClass } from "./thresholds";
  import type { SectionId } from "./monproblems";
  import { t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const m = $derived(v.metrics);
  const d = $derived(v.detail);
  const crit = $derived(v.problems.filter((p) => p.level === "crit").length);
  const warn = $derived(v.problems.length - crit);
  const threads = $derived(d?.perCpu.length || m.cpuCount || 0);
  const ram = $derived(memPct(m.memUsed, m.memTotal));
  const disk = $derived(fullestPartition(d));
  const diskPct = $derived(disk ? (disk.used / disk.total) * 100 : null);

  const sub = $derived(
    [m.ip, m.uptimeSecs != null ? t("mon.upFor", { time: fmtUptime(m.uptimeSecs) }) : "", m.serverTime]
      .filter(Boolean)
      .join(" · "),
  );

  type Tile = {
    id: SectionId;
    label: string;
    value: number | null;
    format: (n: number) => string;
    sub: string;
    key: string;
    color: string;
    max?: number;
    level: ReturnType<typeof thresholdLevel>;
  };
  const tiles = $derived<Tile[]>([
    {
      id: "cpu",
      label: t("mon.cpu"),
      value: m.cpuPct,
      format: fmtPct,
      sub:
        m.load1 != null && threads
          ? t("mon.loadOnThreads", { load: m.load1.toFixed(2), n: threads })
          : "",
      key: "cpu",
      color: SERIES.cpu,
      max: 100,
      level: thresholdLevel(m.cpuPct, v.th.cpu),
    },
    {
      id: "memory",
      label: t("mon.memory"),
      value: ram,
      format: fmtPct,
      sub: d?.memAvailable != null ? t("mon.availableAmount", { size: fmtBytes(d.memAvailable) }) : "",
      key: "ram",
      color: SERIES.ram,
      max: 100,
      level: thresholdLevel(ram, v.th.ram),
    },
    {
      id: "disks",
      label: disk ? t("mon.diskOf", { mount: disk.mount }) : t("mon.disks"),
      value: diskPct,
      format: fmtPct,
      sub: disk ? `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}` : "",
      key: disk ? `fs.${disk.mount}` : "",
      color: SERIES.read,
      max: 100,
      level: thresholdLevel(diskPct, v.th.disk),
    },
    {
      id: "network",
      label: t("mon.network"),
      value: m.netRxRate,
      format: fmtRate,
      sub: [
        m.netTxRate != null ? `↑ ${fmtRate(m.netTxRate)}` : "",
        m.netConns != null ? t("mon.connections", { n: m.netConns }) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      key: "netRx",
      color: SERIES.rx,
      level: "ok",
    },
  ]);

  const psi = $derived(
    (
      [
        ["mon.cpu", d?.psiCpu, "psiCpu", SERIES.cpu],
        ["mon.memory", d?.psiMem, "psiMem", SERIES.ram],
        ["mon.io", d?.psiIo, "psiIo", SERIES.iowait],
      ] as const
    ).filter(([, p]) => p != null),
  );

  const busiestDev = $derived(
    (d?.diskDevs ?? []).reduce<DiskDev | null>(
      (b, x) => (!b || x.readRate + x.writeRate > b.readRate + b.writeRate ? x : b),
      null,
    ),
  );
  const busiestIf = $derived(
    (d?.netIfaces ?? []).reduce<NetIface | null>(
      (b, x) => (!b || x.rxRate + x.txRate > b.rxRate + b.txRate ? x : b),
      null,
    ),
  );
  const consumers = $derived(
    [
      d?.topProcs[0] && [t("mon.cpu"), d.topProcs[0].comm, `${d.topProcs[0].cpu.toFixed(1)}%`],
      d?.topMemProcs[0] && [t("mon.memory"), d.topMemProcs[0].comm, `${d.topMemProcs[0].mem.toFixed(1)}%`],
      busiestDev && [t("mon.disks"), busiestDev.name, fmtRate(busiestDev.readRate + busiestDev.writeRate)],
      busiestIf && [t("mon.network"), busiestIf.name, fmtRate(busiestIf.rxRate + busiestIf.txRate)],
    ].filter((r): r is string[] => !!r),
  );
</script>

<MonHeader
  title={t("mon.sec.overview")}
  {sub}
  primary
  askLabel={t("mon.askReview")}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "overview" }) : undefined}
/>

<MonCard title={t("mon.attention")} tone={crit ? "crit" : warn ? "warn" : "plain"} testid="mon-problems">
  {#snippet aside()}
    {#if v.problems.length}
      <span class="text-danger">{t("mon.critCount", { n: crit })}</span>
      <span> · </span>
      <span class="text-warn">{t("mon.warnCount", { n: warn })}</span>
    {/if}
  {/snippet}
  {#if v.problems.length === 0}
    <p class="flex items-center gap-2 text-xs text-ok" data-testid="mon-all-clear">
      <Icon name="check" size={14} />
      {t("mon.allClear")}
    </p>
  {:else}
    <ul class="divide-y divide-edge/60">
      {#each v.problems as p (p.id)}
        <li class="flex items-center gap-2 py-1.5" data-testid="mon-problem" data-level={p.level}>
          <Icon name="alert" size={15} class="shrink-0 {p.level === 'crit' ? 'text-bad' : 'text-warn'}" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-xs text-text">{t(p.key, p.params)}</div>
            {#if p.note}<div class="truncate font-mono text-meta text-muted">{p.note}</div>{/if}
          </div>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text"
            onclick={() => a.go(p.section)}
          >
            {t(SECTION_LABEL[p.section])}
            <Icon name="arrowRight" size={11} />
          </button>
          {#if a.ask}
            <button
              type="button"
              aria-label={t("ai.ask.button")}
              class="shrink-0 rounded border border-edge px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text"
              onclick={() => a.ask?.({ kind: "problem", problem: p })}
            >
              <Icon name="aiMark" size={12} />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</MonCard>

<div class="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
  {#each tiles as tile (tile.id)}
    <button
      type="button"
      class="min-w-0 overflow-hidden rounded-lg border bg-panel pt-2 text-left hover:border-accent/50 {tile.level === 'crit'
        ? 'border-bad/50'
        : tile.level === 'warn'
          ? 'border-warn/50'
          : 'border-edge'}"
      data-testid="mon-tile-{tile.id}"
      onclick={() => a.go(tile.id)}
    >
      <div class="px-2.5">
        <div class="truncate text-caption uppercase tracking-wider text-muted">{tile.label}</div>
        <TweenNumber value={tile.value} format={tile.format} class="text-xl font-semibold {levelTextClass(tile.level)}" />
        <div class="truncate text-meta text-muted">{tile.sub || " "}</div>
      </div>
      <Chart
        lines={[{ samples: series(v.hist, tile.key), color: tile.color, fill: true }]}
        seq={v.seq}
        max={tile.max}
        slots={SPARK} height={34}
      />
    </button>
  {/each}
</div>

<div class="mt-2 grid gap-2 md:grid-cols-2">
  <MonCard title={t("mon.saturation")}>
    <p class="-mt-1 mb-1.5 text-meta text-muted">{t("mon.saturationHint")}</p>
    {#if psi.length === 0}
      <p class="text-meta text-muted">{t("mon.psiNone")}</p>
    {:else}
      <div class="space-y-1">
        {#each psi as [label, p, key, color] (key)}
          <div class="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
            <span class="text-muted">{t(label)}</span>
            <Chart lines={[{ samples: series(v.hist, key), color, fill: true }]} seq={v.seq} floor={1} slots={SPARK} height={20} />
            <TweenNumber value={p!.avg10} format={(n) => `${n.toFixed(1)}%`} class="text-right" />
          </div>
        {/each}
      </div>
    {/if}
  </MonCard>
  <MonCard title={t("mon.topConsumers")}>
    {#if consumers.length === 0}
      <p class="text-meta text-muted">{t("mon.collecting")}</p>
    {:else}
      <dl class="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
        {#each consumers as [what, who, how] (what)}
          <dt class="text-muted">{what}</dt>
          <dd class="truncate font-mono text-text">{who}</dd>
          <dd class="text-right tabular-nums">{how}</dd>
        {/each}
      </dl>
    {/if}
    <div class="mt-2 border-t border-edge pt-2 text-meta text-muted">
      {[
        m.kernel ? t("mon.kernelIs", { v: m.kernel }) : "",
        d?.timeSynced == null ? "" : d.timeSynced ? t("mon.clockSynced") : t("mon.clockNotSynced"),
        d?.sessions.length ? t("mon.sessionsN", { n: d.sessions.length }) : "",
        d?.listenPorts != null ? t("mon.listeningN", { n: d.listenPorts }) : "",
      ]
        .filter(Boolean)
        .join(" · ")}
    </div>
  </MonCard>
</div>
