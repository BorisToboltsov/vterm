<script lang="ts">
  // The Network section (v1.33): receive above and send below one axis, each
  // interface with its own history and the errors that grew while the page was
  // open, TCP states coloured by name, kernel tables, what listens on which port,
  // and who is logged in.
  import Chart from "./Chart.svelte";
  import { SPARK } from "./chartgeom";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import Meter from "./Meter.svelte";
  import StackedBar from "./StackedBar.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import { fmtCount, fmtRate } from "./format";
  import { series } from "./monhistory";
  import type { MonActions, MonView } from "./monsections";
  import { SERIES, tcpColor } from "./monpalette";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const m = $derived(v.metrics);
  const d = $derived(v.detail);
  const LISTEN_SHOWN = 40;
  const listeners = $derived(
    [...(d?.listenSockets ?? [])].sort((p, q) => p.port - q.port || p.proto.localeCompare(q.proto)),
  );
  const conntrackPct = $derived(d?.conntrack != null && d?.conntrackMax ? (d.conntrack / d.conntrackMax) * 100 : null);
  const grown = (name: string, now: number) => {
    const was = v.baseline?.ifaceBad[name];
    return was == null ? null : now - was;
  };
</script>

<MonHeader
  title={t("mon.network")}
  sub={[m.ip, d ? t("mon.ifacesN", { n: d.netIfaces.length }) : ""].filter(Boolean).join(" · ")}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "network" }) : undefined}
/>

<div class="mb-1 flex flex-wrap items-baseline gap-x-4">
  <span class="text-xl font-semibold" style="color: {SERIES.rx}">↓ <TweenNumber value={m.netRxRate} format={fmtRate} /></span>
  <span class="text-xl font-semibold" style="color: {SERIES.tx}">↑ <TweenNumber value={m.netTxRate} format={fmtRate} /></span>
  {#if m.netConns != null}<span class="ml-auto text-xs text-muted">{t("mon.connEstabN", { n: m.netConns })}</span>{/if}
</div>
<Chart
  lines={[
    { samples: series(v.hist, "netRx"), color: SERIES.rx },
    { samples: series(v.hist, "netTx"), color: SERIES.tx },
  ]}
  seq={v.seq}
  mirror
  scaleLabel
  format={fmtRate}
  marks
  interval={v.interval}
  height={104}
  testid="net-history"
/>

{#if d?.netIfaces.length}
  <MonCard title={t("mon.interfaces")} class="mt-3" testid="net-ifaces">
    {#snippet aside()}<span>{t("mon.errorsSinceOpen")}</span>{/snippet}
    <table class="w-full table-fixed text-meta">
      <thead>
        <tr class="text-left text-muted">
          <th class="font-medium">{t("mon.iface")}</th>
          <th class="w-20 text-right font-medium">↓</th>
          <th class="w-20 text-right font-medium">↑</th>
          <th class="w-24 pl-3 font-medium"></th>
          <th class="w-24 text-right font-medium">{t("mon.errDrop")}</th>
        </tr>
      </thead>
      <tbody>
        {#each d.netIfaces as nf (nf.name)}
          {@const bad = nf.rxErrs + nf.rxDrop + nf.txErrs + nf.txDrop}
          {@const plus = grown(nf.name, bad)}
          <tr class="border-t border-edge/40">
            <td class="truncate py-1 font-mono text-text" use:tooltip={nf.name}>{nf.name}</td>
            <td class="py-1 text-right tabular-nums">{fmtRate(nf.rxRate)}</td>
            <td class="py-1 text-right tabular-nums">{fmtRate(nf.txRate)}</td>
            <td class="py-1 pl-3">
              <Chart
                lines={[
                  { samples: series(v.hist, `if.${nf.name}.rx`), color: SERIES.rx, width: 1 },
                  { samples: series(v.hist, `if.${nf.name}.tx`), color: SERIES.tx, width: 1 },
                ]}
                seq={v.seq}
                mirror
                slots={SPARK}
                height={18}
                dot={false}
              />
            </td>
            <td class="py-1 text-right tabular-nums {plus ? 'text-warn' : 'text-muted'}">
              {fmtCount(bad)}{#if plus} <span>(+{fmtCount(plus)})</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </MonCard>
{/if}

<div class="mt-2 grid gap-2 md:grid-cols-2">
  {#if d?.tcp.length}
    <MonCard title={t("mon.tcpStates")} testid="tcp-states">
      <StackedBar segments={d.tcp.map((s) => ({ label: s.state, value: s.count, color: tcpColor(s.state), text: fmtCount(s.count) }))} />
    </MonCard>
  {/if}
  <MonCard title={t("mon.kernelTables")}>
    <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
      {#if d?.conntrack != null}
        <dt class="text-muted">{t("mon.conntrack")}</dt>
        <dd class="text-right tabular-nums">{fmtCount(d.conntrack)}{d.conntrackMax ? ` / ${fmtCount(d.conntrackMax)}` : ""}</dd>
        {#if conntrackPct != null}<div class="col-span-2"><Meter pct={conntrackPct} class="h-1" /></div>{/if}
      {/if}
      {#if d?.listenPorts != null}
        <dt class="text-muted">{t("mon.listening")}</dt>
        <dd class="text-right tabular-nums">{d.listenPorts}</dd>
      {/if}
    </dl>
  </MonCard>
</div>

{#if listeners.length}
  <MonCard title={t("mon.listenTitle")} class="mt-2" testid="listen-sockets">
    {#snippet aside()}<span>{t("mon.ownerHint")}</span>{/snippet}
    <table class="w-full table-fixed text-meta">
      <thead>
        <tr class="text-left text-muted">
          <th class="w-14 font-medium">{t("mon.proto")}</th>
          <th class="font-medium">{t("mon.address")}</th>
          <th class="w-16 text-right font-medium">{t("mon.port")}</th>
          <th class="w-[40%] pl-3 font-medium">{t("mon.process")}</th>
        </tr>
      </thead>
      <tbody class="font-mono">
        {#each listeners.slice(0, LISTEN_SHOWN) as s, i (i)}
          <tr class="border-t border-edge/40">
            <td class="py-0.5 text-muted">{s.proto}</td>
            <td class="truncate py-0.5 text-text">{s.addr}</td>
            <td class="py-0.5 text-right tabular-nums text-text">{s.port}</td>
            <td class="truncate py-0.5 pl-3 {s.process ? 'text-text' : 'text-muted'}">
              {s.process ? `${s.process}${s.pid != null ? ` (${s.pid})` : ""}` : "—"}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if listeners.length > LISTEN_SHOWN}
      <p class="mt-1 text-meta text-muted">{t("mon.andMore", { n: listeners.length - LISTEN_SHOWN })}</p>
    {/if}
  </MonCard>
{/if}

{#if d?.sessions.length}
  <MonCard title={t("mon.sessionsLabel")} class="mt-2" testid="sessions">
    <table class="w-full table-fixed text-meta">
      <tbody>
        {#each d.sessions as ss, i (i)}
          <tr class="border-t border-edge/40 first:border-t-0">
            <td class="py-0.5 text-text">{ss.user}</td>
            <td class="py-0.5 text-muted">{ss.tty}</td>
            <td class="truncate py-0.5 font-mono text-muted">{ss.from || "—"}</td>
            <td class="py-0.5 text-right text-muted">{ss.login}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </MonCard>
{/if}
