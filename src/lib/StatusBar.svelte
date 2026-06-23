<script lang="ts">
  import { onDestroy } from "svelte";
  import { fetchMetrics, type Metrics } from "./api";
  import {
    diskFree as diskFreeOf,
    fmtBytes,
    fmtRate,
    fmtUptime,
    memPct as memPctOf,
    osIconFor,
  } from "./format";
  import { settings } from "./settings.svelte";
  import { isHidden } from "./util";
  import Icon from "./Icon.svelte";
  import { layout } from "./stores/layout.svelte";
  import { aggregateTransfers, transfersState } from "./stores/transfers.svelte";

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

  const expanded = $derived(settings.statusBarExpanded);
  const cpu = $derived(metrics?.cpuPct ?? null);
  // Left-pad with zeros so the chart keeps a stable width and fills from the right.
  const cpuBars = $derived([
    ...Array(Math.max(0, CPU_SAMPLES - cpuHistory.length)).fill(0),
    ...cpuHistory,
  ]);
  const loadAvg = $derived(
    metrics?.load1 != null
      ? [metrics.load1, metrics.load5, metrics.load15]
          .filter((v) => v != null)
          .map((v) => (v as number).toFixed(2))
          .join(" ")
      : "",
  );
  const loadTitle = $derived(loadAvg ? `Load average: ${loadAvg}` : "CPU utilization");
  const memPct = $derived(memPctOf(metrics?.memUsed ?? null, metrics?.memTotal ?? null));
  const diskFree = $derived(diskFreeOf(metrics?.diskUsed ?? null, metrics?.diskTotal ?? null));
  const diskPct = $derived(memPctOf(metrics?.diskUsed ?? null, metrics?.diskTotal ?? null));
  const swapPct = $derived(memPctOf(metrics?.swapUsed ?? null, metrics?.swapTotal ?? null));
  const usersList = $derived((metrics?.users ?? "").split(/\s+/).filter(Boolean));
  const topProcs = $derived((metrics?.topProc ?? "").split(", ").filter(Boolean));

  // Per-element value width: tight to the content, with two values — one for
  // compact, one for expanded (expanded values are longer). Keeps the bar from
  // reflowing as numbers change while avoiding empty padding.
  const w = (compact: string, exp: string) => (expanded ? exp : compact);

  // Which metric groups are visible: per-metric toggle AND data availability
  // (so metrics a host doesn't expose, e.g. CPU temp, auto-hide rather than show
  // a dash forever). CPU/RAM/disk are core and always shown when enabled.
  const groups = $derived.by(() => {
    const m = metrics;
    if (!m) return [] as string[];
    const it = settings.statusBarItems;
    const g: string[] = [];
    if (it.os) g.push("os");
    if (it.host && (m.user || m.hostname)) g.push("host");
    if (it.ip && m.ip) g.push("ip");
    if (it.uptime && m.uptimeSecs != null) g.push("uptime");
    if (it.kernel && m.kernel) g.push("kernel");
    if (it.serverTime && m.serverTime) g.push("serverTime");
    if (it.cpu) g.push("cpu");
    if (it.load && m.load1 != null) g.push("load");
    if (it.cpuTemp && m.cpuTemp != null) g.push("cpuTemp");
    if (it.topProc && m.topProc) g.push("topProc");
    if (it.ram) g.push("ram");
    if (it.swap && m.swapTotal) g.push("swap");
    if (it.disk) g.push("disk");
    if (it.diskio && (m.diskReadRate != null || m.diskWriteRate != null)) g.push("diskio");
    if (it.net && (m.netRxRate != null || m.netTxRate != null)) g.push("net");
    if (it.netConns && m.netConns != null) g.push("netConns");
    if (it.users && usersList.length > 0) g.push("users");
    return g;
  });

  // SFTP transfers (shared store) → compact aggregate for the bar indicator.
  const summary = $derived(aggregateTransfers(Object.values(transfersState.map)));
</script>

<!--
  Status bar = groups of related metrics. Compact (default) shows icons +
  percentages; expanded adds names, byte totals, the CPU sparkline and load
  average. Groups are separated by a thin `divider()`; per-metric visibility and
  the mode come from settings.
-->
{#snippet divider()}
  <span class="h-3 w-px shrink-0 bg-current" aria-hidden="true"></span>
{/snippet}
<div class="flex items-stretch border-t border-edge bg-panel-alt text-xs text-muted">
  <!-- Scrolling metrics region. The toggle below lives OUTSIDE it, so metrics
       can never show through behind the pinned arrow. -->
  <div class="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap py-1 pl-3 pr-2">
    {#if metrics}
      {#each groups as g, i (g)}
        {#if i > 0}{@render divider()}{/if}
        {#if g === "os"}
          <span class="flex items-center gap-2">
            <Icon
              name={osIconFor(metrics)}
              size={14}
              class="text-muted"
              title={metrics.os || "Unknown OS"}
            />
            {#if expanded}<span>{metrics.prettyName || metrics.os || "—"}</span>{/if}
          </span>
        {:else if g === "host"}
          <span>{metrics.user || "—"}@{metrics.hostname || "—"}</span>
        {:else if g === "cpu"}
          <span class="flex items-center gap-2" title={loadTitle}>
            <Icon name="cpu" size={14} class="text-muted" />
            {#if expanded}
              <span
                data-testid="cpu-chart"
                class="flex h-3.5 w-10 items-end gap-px overflow-hidden rounded-sm border border-edge bg-panel px-px"
              >
                {#each cpuBars as v, k (k)}
                  <span
                    class="min-w-0 flex-1 rounded-[1px]"
                    style="height: {v > 0 ? Math.max(6, Math.min(100, v)) : 0}%; background-color: #22c55e"
                  ></span>
                {/each}
              </span>
            {/if}
            <span class="inline-block text-center tabular-nums {w('w-7', 'w-7')}"
              >{cpu == null ? "—" : `${Math.round(cpu)}%`}</span
            >
          </span>
        {:else if g === "load"}
          <span class="flex items-center gap-2" title="Load average (1 / 5 / 15 min)">
            <Icon name="gauge" size={14} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-[5.25rem]', 'w-[5.25rem]')}"
              >{loadAvg}</span
            >
          </span>
        {:else if g === "ram"}
          <span class="flex items-center gap-2" title="RAM used / total">
            <Icon name="memory" size={14} class="text-muted" />
            <span class="inline-block truncate text-center tabular-nums {w('w-8', 'w-[8.5rem]')}">
              {#if expanded}{fmtBytes(metrics.memUsed)} / {fmtBytes(metrics.memTotal)}{memPct !=
                null
                  ? ` (${memPct}%)`
                  : ""}{:else}{memPct == null ? "—" : `${memPct}%`}{/if}
            </span>
          </span>
        {:else if g === "disk"}
          <span class="flex items-center gap-2" title="Disk free / total on /">
            <Icon name="disk" size={14} class="text-muted" />
            <span class="inline-block truncate text-center tabular-nums {w('w-8', 'w-38')}">
              {#if expanded}{fmtBytes(diskFree)} free / {fmtBytes(metrics.diskTotal)}{:else}{diskPct ==
              null
                ? "—"
                : `${diskPct}%`}{/if}
            </span>
          </span>
        {:else if g === "net"}
          <span class="flex items-center gap-1" title="Network ↑ upload / ↓ download">
            <Icon name="upload" size={13} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-[3.05rem]', 'w-[3.05rem]')}"
              >{fmtRate(metrics.netTxRate)}</span
            >
            <Icon name="download" size={13} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-[3.25rem]', 'w-[3.25rem]')}"
              >{fmtRate(metrics.netRxRate)}</span
            >
          </span>
        {:else if g === "ip"}
          <span class="flex items-center gap-2" title={"IP address: " + metrics.ip}>
            <Icon name="globe" size={14} class="text-muted" />
            <span class="inline-block truncate text-center tabular-nums {w('w-20', 'w-20')}"
              >{metrics.ip}</span
            >
          </span>
        {:else if g === "uptime"}
          <span class="flex items-center gap-2" title="Uptime">
            <Icon name="power" size={14} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-[40px]', 'w-[42px]')}"
              >{fmtUptime(metrics.uptimeSecs)}</span
            >
          </span>
        {:else if g === "kernel"}
          <span class="flex items-center gap-2" title="Kernel: {metrics.kernel}">
            <Icon name="terminal" size={14} class="text-muted" />
            <span class="inline-block truncate text-center {w('w-20', 'w-28')}">{metrics.kernel}</span>
          </span>
        {:else if g === "serverTime"}
          <span class="flex items-center gap-2" title="Server time">
            <Icon name="clock" size={14} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-16', 'w-16')}"
              >{metrics.serverTime}</span
            >
          </span>
        {:else if g === "cpuTemp"}
          <span class="flex items-center gap-2" title="CPU temperature">
            <Icon name="thermometer" size={14} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-9', 'w-9')}"
              >{Math.round(metrics.cpuTemp ?? 0)}°C</span
            >
          </span>
        {:else if g === "topProc"}
          <span class="flex items-center gap-2" title={"Top processes:\n" + topProcs.join("\n")}>
            <Icon name="activity" size={14} class="text-muted" />
            <span class="inline-block truncate text-center tabular-nums {w('w-16', 'w-20')}"
              >{topProcs[0] ?? "—"}</span
            >
          </span>
        {:else if g === "swap"}
          <span class="flex items-center gap-2" title="Swap used / total">
            <Icon name="swap" size={14} class="text-muted" />
            <span class="inline-block truncate text-center tabular-nums {w('w-8', 'w-[8.5rem]')}">
              {#if expanded}{fmtBytes(metrics.swapUsed)} / {fmtBytes(metrics.swapTotal)}{swapPct !=
                null
                  ? ` (${swapPct}%)`
                  : ""}{:else}{swapPct == null ? "—" : `${swapPct}%`}{/if}
            </span>
          </span>
        {:else if g === "diskio"}
          <span class="flex items-center gap-1" title="Disk I/O — read / write">
            <Icon name="diskIo" size={14} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-[3.25rem]', 'w-[3.25rem]')}"
              >{fmtRate(metrics.diskReadRate)}</span
            >
            <span class="text-muted/70">/</span>
            <span class="inline-block text-center tabular-nums {w('w-[3.25rem]', 'w-[3.25rem]')}"
              >{fmtRate(metrics.diskWriteRate)}</span
            >
          </span>
        {:else if g === "netConns"}
          <span class="flex items-center gap-2" title="Established connections">
            <Icon name="plug" size={14} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-2', 'w-2')}"
              >{metrics.netConns}</span
            >
          </span>
        {:else if g === "users"}
          <span class="flex items-center gap-2" title={"Logged-in users:\n" + usersList.join("\n")}>
            <Icon name="users" size={14} class="text-muted" />
            <span class="inline-block text-center tabular-nums {w('w-2', 'w-2')}"
              >{usersList.length}</span
            >
          </span>
        {/if}
      {/each}

      <!-- SFTP transfer indicator (visible even when the SFTP panel is collapsed) -->
      {#if summary.direction}
        {#if groups.length > 0}{@render divider()}{/if}
        <button
          data-testid="transfer-indicator"
          class="flex items-center gap-1.5 rounded px-1 text-muted hover:text-white"
          title="SFTP transfers — click to open the panel"
          onclick={() => (layout.sftpCollapsed = false)}
        >
          <Icon name={summary.direction === "upload" ? "upload" : "download"} size={13} />
          {#if expanded}
            <span class="tabular-nums">{summary.active} {summary.active === 1 ? "file" : "files"}</span>
            <span class="h-1.5 w-12 overflow-hidden rounded-full bg-edge">
              <span class="block h-full rounded-full bg-accent" style="width: {summary.pct}%"></span>
            </span>
          {/if}
          <span class="tabular-nums">{summary.pct}%</span>
        </button>
      {/if}

    {:else if failed}
      <span>Metrics unavailable</span>
    {:else}
      <span>Loading metrics…</span>
    {/if}
  </div>

  <!-- Compact/expanded toggle — sibling of the scroll region (not inside it), so
       it stays fixed at the right edge and metrics never show through behind it.
       Single chevron, like the SFTP/server panel collapse toggles. -->
  {#if metrics}
    <button
      data-testid="statusbar-toggle"
      class="flex shrink-0 items-center self-stretch border-l border-edge px-2 text-muted hover:text-white"
      title={expanded ? "Compact view" : "Expanded view"}
      aria-label={expanded ? "Compact status bar" : "Expanded status bar"}
      aria-pressed={expanded}
      onclick={() => (settings.statusBarExpanded = !settings.statusBarExpanded)}
    >
      <Icon name={expanded ? "chevronLeft" : "chevronRight"} size={14} />
    </button>
  {/if}
</div>
