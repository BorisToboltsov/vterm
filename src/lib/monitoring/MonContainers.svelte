<script lang="ts">
  // The Containers section (v1.33): running Docker containers, polled live while
  // this section is on screen (`fetch_live_extras`), each with its history. A
  // share is drawn only against a limit the container was given (`HostConfig`):
  // without one `docker stats` divides by the host's memory, which is not a
  // ceiling — then the page shows the amount and says there is no limit.
  import Chart from "./Chart.svelte";
  import { SPARK } from "./chartgeom";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import Meter from "./Meter.svelte";
  import Icon from "../ui/Icon.svelte";
  import { fmtBytes } from "./format";
  import { series } from "./monhistory";
  import type { MonActions, MonView } from "./monsections";
  import { SERIES } from "./monpalette";
  import { t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const list = $derived(v.live?.docker ?? v.extras?.docker ?? []);
</script>

<MonHeader
  title={t("mon.containers")}
  sub={t("mon.containersSub", { n: list.length })}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "containers" }) : undefined}
>
  {#if a.openDocker}
    <button
      type="button"
      class="flex items-center gap-1 rounded border border-edge px-2 py-1 text-meta text-text hover:bg-edge"
      onclick={() => a.openDocker?.()}
    >
      <Icon name="container" size={13} />{t("mon.dockerPanel")}
    </button>
  {/if}
</MonHeader>

<MonCard testid="docker-list">
  <table class="w-full table-fixed text-meta">
    <thead>
      <tr class="text-left text-muted">
        <th class="font-medium">{t("mon.container")}</th>
        <th class="w-32 font-medium">{t("mon.cpuOfCore")}</th>
        <th class="w-44 pl-3 font-medium">{t("mon.memAndLimit")}</th>
        <th class="w-24 pl-3 font-medium">{t("mon.sinceOpen")}</th>
      </tr>
    </thead>
    <tbody>
      {#each list as c (c.name)}
        <tr class="border-t border-edge/40 align-top">
          <td class="truncate py-1.5 font-mono text-text">{c.name}</td>
          <td class="py-1.5">
            <div class="tabular-nums text-text">
              {c.cpu.toFixed(1)}%{#if c.cpuLimit != null}<span class="text-muted"> / {t("mon.coresN", { n: c.cpuLimit })}</span>{/if}
            </div>
            {#if c.cpuLimit != null}<Meter pct={c.cpu / c.cpuLimit} color={SERIES.cpu} class="mt-1 h-1" />{/if}
          </td>
          <td class="py-1.5 pl-3">
            {#if c.memLimit != null && c.memUsed != null}
              <div class="flex justify-between gap-2 tabular-nums">
                <span class="text-text">{fmtBytes(c.memUsed)} / {fmtBytes(c.memLimit)}</span>
                <span>{Math.round((c.memUsed / c.memLimit) * 100)}%</span>
              </div>
              <Meter pct={(c.memUsed / c.memLimit) * 100} color={SERIES.ram} class="mt-1 h-1" />
            {:else}
              <span class="tabular-nums text-text">{c.memUsed != null ? fmtBytes(c.memUsed) : c.mem || "—"}</span>
              <span class="text-muted"> · {t("mon.noLimit")}</span>
            {/if}
          </td>
          <td class="py-1.5 pl-3">
            <Chart lines={[{ samples: series(v.hist, `ctr.${c.name}.cpu`), color: SERIES.cpu, width: 1.2 }]} seq={v.seq} floor={1} slots={SPARK} height={18} dot={false} />
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="mt-1 text-meta text-muted">{t("mon.ctrNote")}</p>
</MonCard>
