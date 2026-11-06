<script lang="ts">
  // The System section (v1.33): health (failed units, OOM, clock), pending
  // updates, the host, the hardware, and who logged in. The commands it offers
  // only read (`systemctl --failed`, the package manager's list) and are typed
  // into the session's terminal, where the user sees and runs them.
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import Icon from "../ui/Icon.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import { fmtBytes, fmtMhz, fmtUptime } from "./format";
  import { updatesArgv, type MonActions, type MonView } from "./monsections";
  import { currentLocale, t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const m = $derived(v.metrics);
  const d = $derived(v.detail);
  const x = $derived(v.extras);
  const hw = $derived(x?.hardware ?? null);
  const u = $derived(v.pending);
  const upd = $derived(u?.manager ? updatesArgv(u.manager) : null);
  const cores = $derived(
    hw?.cpuCores != null && hw?.cpuThreads != null
      ? t("mon.coresThreads", { c: hw.cpuCores, t: hw.cpuThreads })
      : hw?.cpuThreads != null
        ? t("mon.threadsN", { n: hw.cpuThreads })
        : "",
  );
  const when = (iso: string) => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(currentLocale());
  };
</script>

{#snippet row(label: string, value: string, cls = "text-text")}
  {#if value}
    <dt class="text-muted">{label}</dt>
    <dd class="min-w-0 truncate text-right tabular-nums {cls}">{value}</dd>
  {/if}
{/snippet}

{#snippet runButton(argv: string[])}
  {#if a.run}
    <button
      type="button"
      class="mt-2 flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta hover:bg-edge"
      onclick={() => a.run?.(argv)}
    >
      <Icon name="terminal" size={12} />{t("mon.inTerminal", { cmd: argv.join(" ") })}
    </button>
  {/if}
{/snippet}

<MonHeader
  section="system"
  {v}
  {a}
  title={t("mon.system")}
  sub={[m.user && m.hostname ? `${m.user}@${m.hostname}` : m.hostname, m.prettyName || m.os].filter(Boolean).join(" · ")}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "system" }) : undefined}
/>

<div class="grid gap-2 md:grid-cols-2" data-testid="system">
  <MonCard title={t("mon.groupHealth")} tone={v.levels.system === "crit" ? "crit" : v.levels.system === "warn" ? "warn" : "plain"}>
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {#if d?.failedUnits != null}
        {@render row(t("mon.failedUnits"), String(d.failedUnits), d.failedUnits > 0 ? "text-bad" : "text-text")}
      {/if}
      {#if x && x.oomKills != null}
        {@render row(t("mon.oomKills"), String(x.oomKills), x.oomKills > 0 ? "text-bad" : "text-text")}
      {/if}
      {#if d?.timeSynced != null}
        {@render row(t("mon.timeSync"), d.timeSynced ? t("mon.synced") : t("mon.notSynced"), d.timeSynced ? "text-ok" : "text-warn")}
      {/if}
    </dl>
    {#if d?.failedUnitNames.length}
      <ul class="mt-1.5 space-y-0.5 font-mono text-meta text-bad" data-testid="failed-units">
        {#each d.failedUnitNames as name (name)}<li class="truncate">{name}</li>{/each}
      </ul>
    {/if}
    {#if (d?.failedUnits ?? 0) > 0}{@render runButton(["systemctl", "--failed"])}{/if}
  </MonCard>

  <MonCard title={t("mon.groupUpdates")}>
    {#if v.pendingLoading}
      <div class="space-y-1" data-testid="updates-skeleton" aria-hidden="true">
        <Skeleton height="12px" width="70%" />
        <Skeleton height="12px" width="55%" />
      </div>
    {:else if u?.manager}
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {@render row(t("mon.manager"), u.manager)}
        {@render row(t("mon.updatesAvailable"), String(u.updates ?? 0), (u.updates ?? 0) > 0 ? "text-warn" : "text-text")}
        {#if u.security != null}
          {@render row(t("mon.security"), String(u.security), u.security > 0 ? "text-bad" : "text-text")}
        {/if}
        {@render row(t("mon.rebootRequired"), u.rebootRequired ? t("mon.yes") : t("mon.no"), u.rebootRequired ? "text-bad" : "text-text")}
      </dl>
      {#if upd && (u.updates ?? 0) > 0}{@render runButton(upd)}{/if}
    {:else}
      <p class="text-meta text-muted">{t("mon.updatesUnknown")}</p>
    {/if}
  </MonCard>

  <MonCard title={t("mon.groupHost")}>
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {@render row(t("mon.os"), m.prettyName || m.os)}
      {@render row(t("mon.kernel"), m.kernel)}
      {@render row(t("mon.ipLabel"), m.ip)}
      {@render row(t("mon.uptimeLabel"), m.uptimeSecs != null ? fmtUptime(m.uptimeSecs) : "")}
      {@render row(t("mon.serverTimeLabel"), m.serverTime)}
      {@render row(t("mon.listening"), d?.listenPorts != null ? String(d.listenPorts) : "")}
    </dl>
  </MonCard>

  <MonCard title={t("mon.groupHardware")} testid="hardware">
    {#if hw}
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {@render row("CPU", hw.cpuModel)}
        {@render row(t("mon.hwCores"), cores)}
        {@render row(t("mon.hwSockets"), hw.cpuSockets != null ? String(hw.cpuSockets) : "")}
        {@render row(t("mon.hwFreq"), hw.cpuMhz ? fmtMhz(hw.cpuMhz) : "")}
        {@render row(t("mon.hwArch"), hw.arch)}
        {@render row(t("mon.hwVirt"), hw.virt)}
        {@render row(t("mon.hwMachine"), hw.machine)}
        {@render row(t("mon.hwBoard"), hw.board)}
        {@render row("BIOS", hw.bios)}
        {@render row("RAM", m.memTotal ? fmtBytes(m.memTotal) : "")}
      </dl>
    {:else}
      <Skeleton height="60px" />
    {/if}
  </MonCard>
</div>

<MonCard title={t("mon.lastLogins")} class="mt-2" testid="logins">
  {#if x == null}
    <Skeleton height="36px" />
  {:else if x.logins == null}
    <p class="text-meta text-muted">{t("mon.loginsUnknown")}</p>
  {:else if x.logins.length === 0}
    <p class="text-meta text-muted">{t("mon.loginsNone")}</p>
  {:else}
    <table class="w-full table-fixed text-meta">
      <tbody>
        {#each x.logins as l, i (i)}
          <tr class="border-t border-edge/40 first:border-t-0">
            <td class="w-24 truncate py-0.5 text-text">{l.user}</td>
            <td class="w-16 truncate py-0.5 text-muted">{l.tty}</td>
            <td class="truncate py-0.5 font-mono text-muted">{l.from}</td>
            <td class="w-40 py-0.5 text-right text-muted">{when(l.at)}</td>
            <td class="w-20 py-0.5 text-right {l.active ? 'text-ok' : 'text-muted'}">{l.active ? t("mon.stillIn") : ""}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</MonCard>
