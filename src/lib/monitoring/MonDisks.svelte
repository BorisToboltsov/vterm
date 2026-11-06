<script lang="ts">
  // The Disks section (v1.33): filesystems by how full they are (space and
  // inodes), reads and writes over the window, each device's throughput,
  // utilization and latency, I/O pressure, descriptors, and SMART.
  import Chart from "./Chart.svelte";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import Meter from "./Meter.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import { fmtBytes, fmtCount, fmtLimit, fmtMs, fmtPct, fmtRate, isUnlimitedLimit } from "./format";
  import { latest, series } from "./monhistory";
  import type { MonActions, MonView } from "./monsections";
  import { SERIES } from "./monpalette";
  import { thresholdLevel, levelTextClass } from "./thresholds";
  import { t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const m = $derived(v.metrics);
  const d = $derived(v.detail);
  const parts = $derived(
    [...(d?.partitions ?? [])].sort((p, q) => (q.total ? q.used / q.total : 0) - (p.total ? p.used / p.total : 0)),
  );
  const pct = (u: number, tot: number) => (tot > 0 ? (u / tot) * 100 : null);
  const fdPct = $derived(
    d?.fileNrUsed != null && d?.fileNrMax && !isUnlimitedLimit(d.fileNrMax) ? (d.fileNrUsed / d.fileNrMax) * 100 : null,
  );
  const iowait = $derived(latest(v.hist, "brk.iowait"));
  const smart = $derived(v.extras?.smart ?? []);
</script>

<MonHeader
  section="disks"
  {v}
  {a}
  title={t("mon.disks")}
  sub={t("mon.disksSub", { fs: parts.length, dev: d?.diskDevs.length ?? 0 })}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "disks" }) : undefined}
/>

<MonCard title={t("mon.filesystemsByFill")} testid="partitions">
  <table class="w-full table-fixed text-meta">
    <thead>
      <tr class="text-left text-muted">
        <th class="font-medium">{t("mon.mount")}</th>
        <th class="w-[44%] font-medium">{t("mon.space")}</th>
        <th class="w-[24%] pl-3 font-medium">{t("mon.inodes")}</th>
      </tr>
    </thead>
    <tbody>
      {#each parts as p (p.mount)}
        {@const sp = pct(p.used, p.total)}
        {@const ip = p.inodesUsed != null && p.inodesTotal ? pct(p.inodesUsed, p.inodesTotal) : null}
        <tr class="border-t border-edge/40 align-top">
          <td class="py-1.5">
            <div class="truncate font-mono text-text">{p.mount}</div>
            <div class="text-muted">{p.fstype}</div>
          </td>
          <td class="py-1.5">
            <div class="flex justify-between gap-2">
              <span class="truncate tabular-nums text-muted">{fmtBytes(p.used)} / {fmtBytes(p.total)}</span>
              <span class="tabular-nums {levelTextClass(thresholdLevel(sp, v.th.disk))}">{fmtPct(sp)}</span>
            </div>
            <Meter pct={sp} level={thresholdLevel(sp, v.th.disk)} class="mt-1 h-1.5" />
          </td>
          <td class="py-1.5 pl-3">
            {#if ip != null}
              <div class="text-right tabular-nums {levelTextClass(thresholdLevel(ip, v.th.inodes))}">{fmtPct(ip)}</div>
              <Meter pct={ip} level={thresholdLevel(ip, v.th.inodes)} class="mt-1 h-1.5" />
            {:else}
              <span class="text-muted">—</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</MonCard>

<MonCard title={t("mon.readWrite")} class="mt-2">
  {#snippet aside()}
    <span class="tabular-nums"><span style="color: {SERIES.read}">R {fmtRate(m.diskReadRate)}</span> · <span style="color: {SERIES.write}">W {fmtRate(m.diskWriteRate)}</span></span>
  {/snippet}
  <Chart
    lines={[
      { samples: series(v.hist, "diskR"), color: SERIES.read },
      { samples: series(v.hist, "diskW"), color: SERIES.write },
    ]}
    seq={v.seq}
    mirror
    scaleLabel
    format={fmtRate}
    marks
    interval={v.interval}
    height={86}
    testid="disk-io-history"
  />
</MonCard>

<div class="mt-2 grid gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
  <MonCard title={t("mon.devices")} testid="disk-devs">
    {#if d?.diskDevs.length}
      <table class="w-full table-fixed text-meta">
        <thead>
          <tr class="text-left text-muted">
            <th class="font-medium">{t("mon.device")}</th>
            <th class="w-16 text-right font-medium">{t("mon.read")}</th>
            <th class="w-16 text-right font-medium">{t("mon.write")}</th>
            <th class="w-20 pl-3 font-medium">{t("mon.busy")}</th>
            <th class="w-14 text-right font-medium">{t("mon.latency")}</th>
          </tr>
        </thead>
        <tbody>
          {#each d.diskDevs as dv (dv.name)}
            <tr class="border-t border-edge/40">
              <td class="truncate py-1 font-mono text-text">{dv.name}</td>
              <td class="py-1 text-right tabular-nums">{fmtRate(dv.readRate)}</td>
              <td class="py-1 text-right tabular-nums">{fmtRate(dv.writeRate)}</td>
              <td class="py-1 pl-3">
                {#if dv.utilPct != null}
                  <Meter pct={dv.utilPct} class="h-1" />
                  <div class="text-right tabular-nums text-muted">{fmtPct(dv.utilPct)}</div>
                {:else}<span class="text-muted">—</span>{/if}
              </td>
              <td class="py-1 text-right tabular-nums">{fmtMs(dv.awaitMs)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="mt-1 text-meta text-muted">{t("mon.latencyNote")}</p>
    {:else if v.loadingDelta}
      <Skeleton height="40px" />
    {:else}
      <p class="text-meta text-muted">{t("mon.noDevices")}</p>
    {/if}
  </MonCard>
  <MonCard title={t("mon.pressure")}>
    <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
      {#if d?.psiIo}
        <dt class="text-muted">{t("mon.psiWindows", { what: "I/O" })}</dt>
        <dd class="text-right tabular-nums">{d.psiIo.avg10.toFixed(1)} / {d.psiIo.avg60.toFixed(1)} / {d.psiIo.avg300.toFixed(1)}</dd>
      {/if}
      {#if iowait != null}
        <dt class="text-muted">{t("mon.iowaitCpu")}</dt>
        <dd class="text-right tabular-nums">{fmtPct(iowait)}</dd>
      {/if}
      {#if d?.fileNrUsed != null}
        <dt class="text-muted">{t("mon.descriptors")}</dt>
        <dd class="text-right tabular-nums {levelTextClass(thresholdLevel(fdPct, v.th.fd))}">{fmtCount(d.fileNrUsed)} / {fmtLimit(d.fileNrMax)}</dd>
      {/if}
      {#if d?.ulimitSoft != null}
        <dt class="text-muted">ulimit -n</dt>
        <dd class="text-right tabular-nums">{d.ulimitSoft} / {d.ulimitHard}</dd>
      {/if}
    </dl>
  </MonCard>
</div>

<MonCard title={t("mon.smart")} class="mt-2" testid="smart-list">
  {#if smart.length === 0}
    <p class="text-meta text-muted">{v.extras ? t("mon.smartNone") : t("mon.collecting")}</p>
  {:else}
    <table class="w-full table-fixed text-meta">
      <thead>
        <tr class="text-left text-muted">
          <th class="font-medium">{t("mon.device")}</th>
          <th class="w-20 font-medium">{t("mon.health")}</th>
          <th class="w-12 text-right font-medium">°C</th>
          <th class="w-20 text-right font-medium">{t("mon.powerOn")}</th>
          <th class="w-24 pl-3 font-medium">{t("mon.wear")}</th>
          <th class="w-20 text-right font-medium">{t("mon.reallocated")}</th>
        </tr>
      </thead>
      <tbody>
        {#each smart as s (s.device)}
          <tr class="border-t border-edge/40">
            <td class="truncate py-1 font-mono text-text">{s.device}</td>
            <td class="py-1 {s.health && s.health !== 'PASSED' ? 'text-bad' : 'text-ok'}">{s.health || "—"}</td>
            <td class="py-1 text-right tabular-nums">{s.temp != null ? Math.round(s.temp) : "—"}</td>
            <td class="py-1 text-right tabular-nums text-muted">{s.powerOnHours != null ? t("mon.hours", { n: fmtCount(s.powerOnHours) }) : "—"}</td>
            <td class="py-1 pl-3">
              {#if s.wearPct != null}
                <Meter pct={s.wearPct} class="h-1" />
                <div class="text-right tabular-nums text-muted">{fmtPct(s.wearPct)}</div>
              {:else}<span class="text-muted">—</span>{/if}
            </td>
            <td class="py-1 text-right tabular-nums {(s.reallocated ?? 0) > 0 ? 'text-warn' : ''}">{s.reallocated ?? "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</MonCard>
