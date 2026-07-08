<script lang="ts">
  // Detailed monitoring overlay (Phase «Расширение мониторинга»). A full-screen
  // Modal that polls the active session for rich metrics — graphs for CPU/load/
  // RAM, per-core utilization, per-filesystem space + inodes, file descriptors,
  // PSI saturation, TCP states, and (lazily) pending package updates.
  //
  // Data is fetched ONLY while open: the poll loop starts on open and is torn
  // down on close, so a closed overlay costs nothing on the server.
  import {
    fetchMetrics,
    fetchMetricsDetail,
    fetchPendingUpdates,
    fetchExtras,
    type Extras,
    type Metrics,
    type MetricsDetail,
    type PendingUpdates,
    type Psi,
    type Sensor,
  } from "./api";
  import { tooltip } from "./actions/tooltip";
  import {
    fmtBytes,
    fmtLimit,
    fmtPct,
    fmtRate,
    fmtUptime,
    isUnlimitedLimit,
    memPct,
    osIconFor,
  } from "./format";
  import { settings } from "./settings.svelte";
  import { levelTextClass, thresholdClass, type ThresholdLevel } from "./thresholds";
  import {
    cpuHealth,
    extrasHealth,
    fsHealth,
    hasTempData,
    loadHealth,
    memHealth,
    netHealth,
    sensorLevel as sensorLevelOf,
    tempHealth,
    worstLevel,
  } from "./monhealth";
  import { isHidden } from "./util";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import Chart from "./Chart.svelte";
  import StackedBar from "./StackedBar.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { t } from "./i18n";

  // Series colours (data-viz, like Sparkline's colour prop). Token-based where a
  // semantic colour exists; tints for composition segments.
  const C_CPU = "#22c55e";
  const C_RAM = "#89b4fa";
  const C_LOAD = "#f9e2af";
  const C_LOAD5 = "#cbb892";
  const C_LOAD15 = "#8a7a55";
  const C_NET_RX = "#89b4fa";
  const C_NET_TX = "#22c55e";
  const TCP_COLORS = ["var(--color-accent)", "#22c55e", "#f9e2af", "#89b4fa", "#c4a7e7"];

  let {
    open = $bindable(false),
    sessionId,
    onInstallTool,
  }: {
    open?: boolean;
    sessionId: string;
    /** Offer to install a server tool (e.g. "sensors") via the Phase 12.8 flow. */
    onInstallTool?: (toolName: string) => void;
  } = $props();

  let metrics = $state<Metrics | null>(null);
  let detail = $state<MetricsDetail | null>(null);
  let failed = $state(false);
  let pending = $state<PendingUpdates | null>(null);
  let pendingLoading = $state(false);
  let extras = $state<Extras | null>(null);
  // Successful polls so far. Delta metrics (per-core, CPU breakdown, ctx/intr rates,
  // per-device disk I/O) need two samples, so they're empty until the 2nd poll —
  // we show skeletons while pollCount < 2.
  let pollCount = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;

  // Rolling histories (built up from the moment the overlay opens).
  const HISTORY = 40;
  let cpuHist = $state<number[]>([]);
  let ramHist = $state<number[]>([]);
  let swapHist = $state<number[]>([]);
  let loadHist = $state<number[]>([]);
  let load5Hist = $state<number[]>([]);
  let load15Hist = $state<number[]>([]);
  let netRxHist = $state<number[]>([]);
  let netTxHist = $state<number[]>([]);

  function pushHist(arr: number[], v: number | null): number[] {
    return v == null ? arr : [...arr, v].slice(-HISTORY);
  }

  async function poll() {
    if (isHidden()) return;
    try {
      const [m, d] = await Promise.all([fetchMetrics(sessionId), fetchMetricsDetail(sessionId)]);
      metrics = m;
      detail = d;
      failed = false;
      cpuHist = pushHist(cpuHist, m.cpuPct);
      ramHist = pushHist(ramHist, memPct(m.memUsed, m.memTotal));
      swapHist = pushHist(swapHist, memPct(m.swapUsed, m.swapTotal));
      loadHist = pushHist(loadHist, m.load1);
      load5Hist = pushHist(load5Hist, m.load5);
      load15Hist = pushHist(load15Hist, m.load15);
      netRxHist = pushHist(netRxHist, m.netRxRate);
      netTxHist = pushHist(netTxHist, m.netTxRate);
      pollCount += 1;
    } catch {
      failed = true;
    }
  }

  // Pending updates are heavy: fetch once, lazily, AFTER the overlay has rendered.
  // Surfaced inline in the System block (static-info group); while in flight the
  // group shows a skeleton (like SFTP loading).
  async function loadPending() {
    try {
      pending = await fetchPendingUpdates(sessionId);
    } catch {
      pending = null;
    } finally {
      pendingLoading = false;
    }
  }

  // Optional extras (GPU/Docker/SMART/OOM) — also lazy, fetched once on open.
  async function loadExtras() {
    try {
      extras = await fetchExtras(sessionId);
    } catch {
      extras = null;
    }
  }

  function reset() {
    metrics = null;
    detail = null;
    pending = null;
    pendingLoading = false;
    extras = null;
    pollCount = 0;
    failed = false;
    cpuHist = [];
    ramHist = [];
    swapHist = [];
    loadHist = [];
    load5Hist = [];
    load15Hist = [];
    netRxHist = [];
    netTxHist = [];
  }

  // Start/stop the poll loop with the overlay's open state.
  $effect(() => {
    if (!open) {
      clearInterval(timer);
      reset();
      return;
    }
    const everyMs = Math.max(2, settings.statusPollInterval) * 1000;
    void sessionId;
    pendingLoading = true;
    poll();
    // Defer the heavy pending-updates + extras probes so the page paints first.
    const pendingTimer = setTimeout(loadPending, 300);
    const extrasTimer = setTimeout(loadExtras, 400);
    timer = setInterval(poll, everyMs);
    return () => {
      clearInterval(timer);
      clearTimeout(pendingTimer);
      clearTimeout(extrasTimer);
    };
  });

  // ── Derived values + threshold colouring ───────────────────────────────────
  const th = $derived(settings.statusBarThresholds);
  const cpu = $derived(metrics?.cpuPct ?? null);
  const ramPct = $derived(memPct(metrics?.memUsed ?? null, metrics?.memTotal ?? null));
  const swapPctV = $derived(memPct(metrics?.swapUsed ?? null, metrics?.swapTotal ?? null));
  const cores = $derived(detail?.perCpu ?? []);
  // True while delta metrics aren't ready yet (only one poll done) — drives skeletons.
  const loadingDelta = $derived(pollCount < 2);
  const loadCores = $derived(
    metrics?.load1 != null && cores.length > 0 ? metrics.load1 / cores.length : null,
  );
  // ── Per-block health (ok|warn|crit) — see monhealth.ts for the derivation. ──
  const cpuLvl = $derived(cpuHealth(metrics, th));
  const memLvl = $derived(memHealth(metrics, th));
  const fsLvl = $derived(fsHealth(detail, th));
  const loadLvl = $derived(loadHealth(metrics?.load1 ?? null, loadCores, th.load));
  const netLvl = $derived(netHealth(detail));
  const tempLvl = $derived(tempHealth(detail, metrics, th));
  const extrasLvl = $derived(extrasHealth(extras));
  const tempShown = $derived(hasTempData(detail, metrics));
  // Static hardware spec (Фаза 20.16), part of the once-on-open extras probe.
  const hw = $derived(extras?.hardware ?? null);
  const hasHw = $derived(
    !!hw &&
      !!(
        hw.cpuModel ||
        hw.arch ||
        hw.machine ||
        hw.board ||
        hw.virt ||
        hw.bios ||
        hw.cpuThreads != null
      ),
  );
  // Show the virtualization badge only when it's a guest (kvm/vmware/docker/lxc…),
  // not on bare metal ("none") or when undetectable (empty).
  const virtBadge = $derived(hw?.virt && hw.virt !== "none" ? hw.virt : null);

  /** MHz → "2.40 GHz" (or "800 MHz" below 1 GHz); empty when unknown. */
  function fmtFreq(mhz: number | null | undefined): string {
    if (mhz == null) return "";
    return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`;
  }
  /** "8 / 16" cores/threads, tolerating a missing half. */
  function fmtCores(cores: number | null | undefined, threads: number | null | undefined): string {
    if (cores != null && threads != null) return `${cores} / ${threads}`;
    if (threads != null) return String(threads);
    if (cores != null) return String(cores);
    return "";
  }

  // A small dot colour + a pill text-colour class for a health level (ok = green).
  function dotColor(l: ThresholdLevel): string {
    return l === "crit" ? "var(--color-danger)" : l === "warn" ? "var(--color-warn)" : "var(--color-green-500)";
  }
  function pillCls(l: ThresholdLevel): string {
    return l === "crit" ? "text-danger" : l === "warn" ? "text-warn" : "text-green-500";
  }

  // At-a-glance health summary (clickable chips → scroll to the section).
  const extrasShown = $derived(
    !!extras &&
      (extras.gpus.length > 0 ||
        extras.docker.length > 0 ||
        extras.smart.length > 0 ||
        (extras.oomKills ?? 0) > 0),
  );
  const healthItems = $derived(
    [
      { id: "mon-cpu", label: t("mon.cpu"), level: cpuLvl, show: true },
      { id: "mon-memory", label: t("mon.memory"), level: memLvl, show: true },
      { id: "mon-fs", label: t("mon.filesystems"), level: fsLvl, show: true },
      { id: "mon-load", label: t("mon.loadHistory"), level: loadLvl, show: true },
      { id: "mon-network", label: t("mon.network"), level: netLvl, show: true },
      { id: "mon-temp", label: t("mon.temperature"), level: tempLvl, show: tempShown },
      { id: "mon-extras", label: t("mon.extras"), level: extrasLvl, show: extrasShown },
    ].filter((i) => i.show),
  );
  const overallLvl = $derived(worstLevel(healthItems.map((i) => i.level)));
  const overallText = $derived(
    overallLvl === "crit"
      ? t("mon.healthCrit")
      : overallLvl === "warn"
        ? t("mon.healthWarn")
        : t("mon.healthOk"),
  );

  // Expand-and-scroll to a section when its health chip is clicked.
  function focusSection(id: string) {
    const reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() =>
      document
        .getElementById(id)
        ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }),
    );
  }

  function partPct(used: number, total: number): number | null {
    return total > 0 ? (used / total) * 100 : null;
  }
  // A ~i64::MAX `fs.file-max` means "no limit": skip the percentage/threshold and
  // render the ceiling as ∞ instead of an astronomical number.
  const fdUnlimited = $derived(isUnlimitedLimit(detail?.fileNrMax ?? null));
  const fdPct = $derived(
    detail?.fileNrUsed != null && detail?.fileNrMax && !fdUnlimited
      ? (detail.fileNrUsed / detail.fileNrMax) * 100
      : null,
  );

  const sensors = $derived(detail?.sensors ?? []);
  const coreSensors = $derived(sensors.filter((s) => /^core\s*\d+/i.test(s.label)));

  // Per-sensor level (shared rule in monhealth) bound to the current cpuTemp threshold.
  const sensorLevel = (s: Sensor) => sensorLevelOf(s, th.cpuTemp);
  function sensorFill(s: { temp: number; crit: number | null }): number {
    return s.crit ? Math.min(100, (s.temp / s.crit) * 100) : Math.min(100, s.temp);
  }

  const topMemProcs = $derived((detail?.topMem ?? "").split(", ").filter(Boolean));
  const topCpuProcs = $derived((metrics?.topProc ?? "").split(", ").filter(Boolean));
  const usersList = $derived((metrics?.users ?? "").split(/\s+/).filter(Boolean));

  function psiLabel(p: Psi | null | undefined): string {
    return p ? `${p.avg10.toFixed(1)} / ${p.avg60.toFixed(1)} / ${p.avg300.toFixed(1)}` : "—";
  }
</script>

<Modal
  {open}
  title={t("mon.title")}
  width="w-[min(96vw,1180px)]"
  showClose
  onclose={() => (open = false)}
>
  {#if !metrics && !failed}
    <!-- First paint before the first poll resolves. -->
    <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="monitoring-loading">
      {#each Array(6) as _, i (i)}
        <Skeleton height="160px" class="rounded" />
      {/each}
    </div>
  {:else if failed}
    <p class="py-8 text-center text-sm text-danger">{t("mon.fetchFailed")}</p>
  {:else if metrics}
    {#snippet sysField(label: string, value: string, valueClass?: string)}
      <div class="flex justify-between gap-2">
        <dt class="text-muted">{label}</dt>
        <dd class="min-w-0 truncate tabular-nums {valueClass || 'text-text'}" title={value}>{value}</dd>
      </div>
    {/snippet}
    <div class="max-h-[80vh] overflow-y-auto pr-1">
      <!-- System block (grouped static info) -->
      <section data-testid="system" class="mb-3 rounded border border-edge bg-panel p-3">
        <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon name={osIconFor(metrics)} size={16} class="text-muted" />
          <span class="text-sm text-text">{metrics.user || "—"}@{metrics.hostname || "—"}</span>
          <span class="text-xs text-muted">{metrics.prettyName || metrics.os || "—"}</span>
          {#if virtBadge}
            <span
              class="rounded bg-edge px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent"
              data-testid="virt-badge"
              use:tooltip={t("mon.hwVirt")}>{virtBadge}</span
            >
          {/if}
          <span class="ml-auto flex items-center gap-1.5 text-xs {pillCls(overallLvl)}">
            <span class="h-2 w-2 rounded-full" style="background-color: {dotColor(overallLvl)}"></span>
            {overallText}
          </span>
        </div>
        <!-- Health summary: one chip per block, click to jump to it -->
        <div class="mb-3 flex flex-wrap gap-1.5" data-testid="health-summary">
          {#each healthItems as h (h.id)}
            <button
              type="button"
              onclick={() => focusSection(h.id)}
              class="rounded bg-edge px-2 py-0.5 text-[11px] hover:opacity-80 {pillCls(h.level)}"
            >
              {h.label}
            </button>
          {/each}
        </div>
        {#snippet sysGroup(title: string, body: import("svelte").Snippet)}
          <div>
            <div class="mb-1 text-[11px] uppercase tracking-wider text-muted">{title}</div>
            <dl class="space-y-0.5">{@render body()}</dl>
          </div>
        {/snippet}
        <div class="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4">
          {#if metrics.kernel || metrics.uptimeSecs != null || cores.length > 0 || metrics.serverTime}
            {#snippet hostBody()}
              {#if metrics!.kernel}{@render sysField(t("mon.kernel"), metrics!.kernel)}{/if}
              {#if metrics!.uptimeSecs != null}{@render sysField(t("mon.uptimeLabel"), fmtUptime(metrics!.uptimeSecs))}{/if}
              {#if cores.length > 0}{@render sysField(t("mon.coresLabel"), String(cores.length))}{/if}
              {#if metrics!.serverTime}{@render sysField(t("mon.serverTimeLabel"), metrics!.serverTime)}{/if}
            {/snippet}
            {@render sysGroup(t("mon.groupHost"), hostBody)}
          {/if}
          {#if metrics.ip || detail?.listenPorts != null || detail?.conntrack != null}
            {#snippet netBody()}
              {#if metrics!.ip}{@render sysField(t("mon.ipLabel"), metrics!.ip)}{/if}
              {#if detail?.listenPorts != null}{@render sysField(t("mon.listening"), String(detail.listenPorts))}{/if}
              {#if detail?.conntrack != null}{@render sysField(t("mon.conntrack"), detail.conntrackMax ? `${detail.conntrack} / ${detail.conntrackMax}` : String(detail.conntrack))}{/if}
            {/snippet}
            {@render sysGroup(t("mon.network"), netBody)}
          {/if}
          {#if detail?.timeSynced != null || detail?.failedUnits != null}
            {#snippet healthBody()}
              {#if detail?.timeSynced != null}{@render sysField(t("mon.timeSync"), detail.timeSynced ? t("mon.synced") : t("mon.notSynced"), detail.timeSynced ? undefined : "text-warn")}{/if}
              {#if detail?.failedUnits != null}{@render sysField(t("mon.failedUnits"), String(detail.failedUnits), detail.failedUnits > 0 ? "text-danger" : undefined)}{/if}
            {/snippet}
            {@render sysGroup(t("mon.groupHealth"), healthBody)}
          {/if}
          {#if pendingLoading || (pending && pending.manager)}
            {#snippet updatesBody()}
              {#if pending && pending.manager}
                {@render sysField(t("mon.manager"), pending.manager)}
                {@render sysField(t("mon.updatesAvailable"), String(pending.updates ?? 0), (pending.updates ?? 0) > 0 ? "text-warn" : undefined)}
                {#if pending.security != null}{@render sysField(t("mon.security"), String(pending.security), (pending.security ?? 0) > 0 ? "text-danger" : undefined)}{/if}
                {@render sysField(t("mon.rebootRequired"), pending.rebootRequired ? t("mon.yes") : t("mon.no"), pending.rebootRequired ? "text-danger" : undefined)}
              {:else}
                <div class="space-y-1" data-testid="updates-skeleton" aria-hidden="true">
                  <Skeleton height="12px" width="70%" />
                  <Skeleton height="12px" width="55%" />
                  <Skeleton height="12px" width="60%" />
                </div>
              {/if}
            {/snippet}
            {@render sysGroup(t("mon.groupUpdates"), updatesBody)}
          {/if}
          {#if hasHw}
            <div class="col-span-2" data-testid="hardware">
              <div class="mb-1 text-[11px] uppercase tracking-wider text-muted">{t("mon.groupHardware")}</div>
              <dl class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {#if hw!.cpuModel}{@render sysField("CPU", hw!.cpuModel)}{/if}
                {#if fmtCores(hw!.cpuCores, hw!.cpuThreads)}{@render sysField(t("mon.hwCores"), fmtCores(hw!.cpuCores, hw!.cpuThreads))}{/if}
                {#if hw!.cpuSockets != null}{@render sysField(t("mon.hwSockets"), String(hw!.cpuSockets))}{/if}
                {#if fmtFreq(hw!.cpuMhz)}{@render sysField(t("mon.hwFreq"), fmtFreq(hw!.cpuMhz))}{/if}
                {#if hw!.arch}{@render sysField(t("mon.hwArch"), hw!.arch)}{/if}
                {#if hw!.virt}{@render sysField(t("mon.hwVirt"), hw!.virt)}{/if}
                {#if hw!.machine}{@render sysField(t("mon.hwMachine"), hw!.machine)}{/if}
                {#if hw!.board}{@render sysField(t("mon.hwBoard"), hw!.board)}{/if}
                {#if hw!.bios}{@render sysField("BIOS", hw!.bios)}{/if}
                {#if metrics.memTotal}{@render sysField("RAM", fmtBytes(metrics.memTotal))}{/if}
              </dl>
            </div>
          {/if}
        </div>
      </section>

      <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="detail-sections">
        <!-- ── CPU ── -->
        <section id="mon-cpu" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="cpu" size={14} /> {t("mon.cpu")}
            <span class="ml-auto h-2 w-2 rounded-full" style="background-color: {dotColor(cpuLvl)}"></span>
          </h3>
          <div class="mb-2 flex items-end justify-between gap-3">
            <span class="text-2xl font-semibold tabular-nums {thresholdClass(cpu, th.cpu)}">{fmtPct(cpu)}</span>
            <Chart
              series={[{ values: cpuHist, color: C_CPU, fill: true }]}
              testid="cpu-history"
              class="h-10 w-40"
            />
          </div>
          <!-- Per-core utilization -->
          {#if cores.length > 0}
            <div class="mb-2" data-testid="per-core">
              <div class="mb-1 text-[11px] text-muted">{t("mon.cores", { n: cores.length })}</div>
              <div class="flex h-12 items-end gap-0.5">
                {#each cores as c, i (i)}
                  <span
                    class="min-w-0 flex-1 rounded-[1px]"
                    title="cpu{i}: {Math.round(c)}%"
                    style="height: {Math.max(4, c)}%; background-color: var({thresholdClass(c, th.cpu) === 'text-danger' ? '--color-danger' : thresholdClass(c, th.cpu) === 'text-warn' ? '--color-warn' : '--color-accent'})"
                  ></span>
                {/each}
              </div>
            </div>
          {:else if loadingDelta}
            <div class="mb-2" data-testid="per-core-skeleton" aria-hidden="true">
              <Skeleton height="10px" width="40%" class="mb-1" />
              <Skeleton height="48px" />
            </div>
          {/if}
          <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {#if loadCores != null}
              <dt class="text-muted">{t("mon.loadPerCore")}</dt>
              <dd class="text-right tabular-nums">{loadCores.toFixed(2)}</dd>
            {/if}
            {#if detail?.ctxtRate != null}
              <dt class="text-muted">{t("mon.ctxSwitch")}</dt>
              <dd class="text-right tabular-nums">{detail.ctxtRate.toLocaleString()}</dd>
            {:else if loadingDelta}
              <dt class="text-muted">{t("mon.ctxSwitch")}</dt>
              <dd class="flex justify-end"><Skeleton height="12px" width="44px" /></dd>
            {/if}
            {#if detail?.intrRate != null}
              <dt class="text-muted">{t("mon.interrupts")}</dt>
              <dd class="text-right tabular-nums">{detail.intrRate.toLocaleString()}</dd>
            {:else if loadingDelta}
              <dt class="text-muted">{t("mon.interrupts")}</dt>
              <dd class="flex justify-end"><Skeleton height="12px" width="44px" /></dd>
            {/if}
            {#if metrics.cpuTemp != null}
              <dt class="text-muted">{t("mon.temperature")}</dt>
              <dd class="text-right tabular-nums {thresholdClass(metrics.cpuTemp, th.cpuTemp)}">{Math.round(metrics.cpuTemp)}°C</dd>
            {/if}
          </dl>
          {#if detail?.cpuBreakdown}
            <StackedBar
              class="mt-2"
              testid="cpu-breakdown"
              segments={[
                { label: t("mon.user"), value: detail.cpuBreakdown.user, color: "var(--color-accent)" },
                { label: t("mon.system"), value: detail.cpuBreakdown.system, color: C_RAM },
                { label: t("mon.iowait"), value: detail.cpuBreakdown.iowait, color: C_LOAD },
                { label: t("mon.steal"), value: detail.cpuBreakdown.steal, color: "var(--color-danger)" },
                { label: t("mon.idle"), value: detail.cpuBreakdown.idle, color: "var(--color-edge)" },
              ]}
            />
          {:else if loadingDelta}
            <div class="mt-2" data-testid="cpu-breakdown-skeleton" aria-hidden="true">
              <Skeleton height="10px" class="rounded-full" />
            </div>
          {/if}
          {#if detail?.topProcs && detail.topProcs.length > 0}
            <div class="mt-2 border-t border-edge pt-2" data-testid="top-procs">
              <div class="mb-1 text-[11px] text-muted">{t("mon.topProcs")}</div>
              <table class="w-full text-[11px]">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="font-medium">PID</th>
                    <th class="font-medium">{t("mon.process")}</th>
                    <th class="text-right font-medium">CPU</th>
                    <th class="text-right font-medium">MEM</th>
                  </tr>
                </thead>
                <tbody class="font-mono">
                  {#each detail.topProcs as p (p.pid)}
                    <tr class="border-t border-edge/40">
                      <td class="py-0.5 tabular-nums text-muted">{p.pid}</td>
                      <td class="truncate py-0.5 text-text" title="{p.user} · {p.comm}">{p.comm}</td>
                      <td class="py-0.5 text-right tabular-nums">{p.cpu.toFixed(1)}%</td>
                      <td class="py-0.5 text-right tabular-nums text-muted">{p.mem.toFixed(1)}%</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else if topCpuProcs.length > 0}
            <div class="mt-2 border-t border-edge pt-2 text-[11px] text-muted">
              {t("mon.topCpu")} <span class="text-text">{topCpuProcs.join(", ")}</span>
            </div>
          {/if}
        </section>

        <!-- ── Memory ── -->
        <section id="mon-memory" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="memory" size={14} /> {t("mon.memory")}
            <span class="ml-auto h-2 w-2 rounded-full" style="background-color: {dotColor(memLvl)}"></span>
          </h3>
          <div class="mb-2 flex items-end justify-between gap-3">
            <div class="flex items-baseline gap-2">
              <span class="text-2xl font-semibold tabular-nums {thresholdClass(ramPct, th.ram)}">{fmtPct(ramPct)}</span>
              {#if metrics.memTotal}
                <span class="text-xs text-muted">{t("mon.ofTotal", { size: fmtBytes(metrics.memTotal) })}</span>
              {/if}
            </div>
            <Chart series={[{ values: ramHist, color: C_RAM, fill: true }]} class="h-10 w-40" />
          </div>
          {#if detail?.memCached != null && detail?.memFree != null}
            <StackedBar
              class="mb-2"
              testid="mem-composition"
              segments={[
                { label: t("mon.used"), value: metrics.memUsed ?? 0, color: "var(--color-accent)" },
                {
                  label: t("mon.cacheBuffers"),
                  value: (detail.memCached ?? 0) + (detail.memBuffers ?? 0),
                  color: C_RAM,
                },
                { label: t("mon.free"), value: detail.memFree ?? 0, color: "var(--color-edge)" },
              ]}
            />
          {:else}
            <div class="mb-2 h-2 w-full overflow-hidden rounded-full bg-edge">
              <span class="block h-full rounded-full bg-accent" style="width: {ramPct ?? 0}%"></span>
            </div>
          {/if}
          <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt class="text-muted">{t("mon.total")}</dt>
            <dd class="text-right tabular-nums">{fmtBytes(metrics.memTotal)}</dd>
            <dt class="text-muted">{t("mon.used")}</dt>
            <dd class="text-right tabular-nums">{fmtBytes(metrics.memUsed)}</dd>
            {#if detail?.memAvailable != null}
              <dt class="text-muted">{t("mon.available")}</dt>
              <dd class="text-right tabular-nums">{fmtBytes(detail.memAvailable)}</dd>
            {/if}
            {#if detail?.memCached != null}
              <dt class="text-muted">{t("mon.cacheBuffers")}</dt>
              <dd class="text-right tabular-nums">{fmtBytes(detail.memCached)} / {fmtBytes(detail.memBuffers)}</dd>
            {/if}
            {#if detail?.memFree != null}
              <dt class="text-muted">{t("mon.free")}</dt>
              <dd class="text-right tabular-nums">{fmtBytes(detail.memFree)}</dd>
            {/if}
            {#if metrics.swapTotal}
              <dt class="text-muted">{t("mon.swap")}</dt>
              <dd class="text-right tabular-nums {thresholdClass(swapPctV, th.swap)}">
                {fmtBytes(metrics.swapUsed)} / {fmtBytes(metrics.swapTotal)} ({fmtPct(swapPctV)})
              </dd>
            {/if}
            {#if detail?.psiMem}
              <dt class="text-muted">PSI MEM</dt>
              <dd class="text-right tabular-nums">{psiLabel(detail.psiMem)}</dd>
            {/if}
          </dl>
          {#if detail?.topMemProcs && detail.topMemProcs.length > 0}
            <div class="mt-2 border-t border-edge pt-2" data-testid="top-mem">
              <div class="mb-1 text-[11px] text-muted">{t("mon.topMemProcs")}</div>
              <table class="w-full text-[11px]">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="font-medium">PID</th>
                    <th class="font-medium">{t("mon.process")}</th>
                    <th class="text-right font-medium">MEM</th>
                    <th class="text-right font-medium">CPU</th>
                  </tr>
                </thead>
                <tbody class="font-mono">
                  {#each detail.topMemProcs as p (p.pid)}
                    <tr class="border-t border-edge/40">
                      <td class="py-0.5 tabular-nums text-muted">{p.pid}</td>
                      <td class="truncate py-0.5 text-text" title="{p.user} · {p.comm}">{p.comm}</td>
                      <td class="py-0.5 text-right tabular-nums">{p.mem.toFixed(1)}%</td>
                      <td class="py-0.5 text-right tabular-nums text-muted">{p.cpu.toFixed(1)}%</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else if topMemProcs.length > 0}
            <div class="mt-2 border-t border-edge pt-2 text-[11px] text-muted">
              {t("mon.topMem")} <span class="text-text">{topMemProcs.join(", ")}</span>
            </div>
          {/if}
        </section>

        <!-- ── Filesystems / descriptors ── -->
        <section id="mon-fs" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="disk" size={14} /> {t("mon.filesystems")}
            <span class="ml-auto h-2 w-2 rounded-full" style="background-color: {dotColor(fsLvl)}"></span>
          </h3>
          {#if detail?.partitions && detail.partitions.length > 0}
            <div class="space-y-2" data-testid="partitions">
              {#each detail.partitions as p (p.mount)}
                {@const sp = partPct(p.used, p.total)}
                {@const ip = p.inodesUsed != null && p.inodesTotal ? partPct(p.inodesUsed, p.inodesTotal) : null}
                <div class="text-xs">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="truncate font-medium text-text" title="{p.mount} ({p.fstype})">{p.mount}</span>
                    <span class="shrink-0 tabular-nums text-muted {thresholdClass(sp, th.disk)}">
                      {fmtBytes(p.used)} / {fmtBytes(p.total)} ({fmtPct(sp)})
                    </span>
                  </div>
                  <div class="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-edge">
                    <span
                      class="block h-full rounded-full"
                      style="width: {sp ?? 0}%; background-color: var({thresholdClass(sp, th.disk) === 'text-danger' ? '--color-danger' : thresholdClass(sp, th.disk) === 'text-warn' ? '--color-warn' : '--color-accent'})"
                    ></span>
                  </div>
                  {#if ip != null}
                    <div class="mt-0.5 flex justify-between text-[11px] text-muted">
                      <span>{t("mon.inodes")}</span>
                      <span class="tabular-nums {thresholdClass(ip, th.inodes)}">{p.inodesUsed?.toLocaleString()} / {p.inodesTotal?.toLocaleString()} ({fmtPct(ip)})</span>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
          <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-edge pt-2 text-xs">
            {#if detail?.fileNrUsed != null}
              <dt class="text-muted" use:tooltip={t("mon.descriptorsTitle")}>{t("mon.descriptors")}</dt>
              <dd class="text-right tabular-nums {thresholdClass(fdPct, th.fd)}">
                {detail.fileNrUsed.toLocaleString()} / {fmtLimit(detail.fileNrMax)} ({fmtPct(fdPct)})
              </dd>
            {/if}
            {#if detail?.ulimitSoft != null}
              <dt class="text-muted" use:tooltip={t("mon.ulimitTitle")}>ulimit -n</dt>
              <dd class="text-right tabular-nums">{detail.ulimitSoft} / {detail.ulimitHard}</dd>
            {/if}
            <dt class="text-muted">{t("mon.diskIoRw")}</dt>
            <dd class="text-right tabular-nums">{fmtRate(metrics.diskReadRate)} / {fmtRate(metrics.diskWriteRate)}</dd>
            {#if detail?.psiIo}
              <dt class="text-muted">PSI I/O</dt>
              <dd class="text-right tabular-nums">{psiLabel(detail.psiIo)}</dd>
            {/if}
          </dl>
          {#if detail?.diskDevs && detail.diskDevs.length > 0}
            <div class="mt-2 border-t border-edge pt-2" data-testid="disk-devs">
              <div class="mb-1 text-[11px] text-muted">{t("mon.devices")}</div>
              <table class="w-full text-[11px]">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="font-medium">{t("mon.device")}</th>
                    <th class="text-right font-medium">{t("mon.read")}</th>
                    <th class="text-right font-medium">{t("mon.write")}</th>
                  </tr>
                </thead>
                <tbody class="font-mono">
                  {#each detail.diskDevs as dv (dv.name)}
                    <tr class="border-t border-edge/40">
                      <td class="py-0.5 text-text">{dv.name}</td>
                      <td class="py-0.5 text-right tabular-nums">{fmtRate(dv.readRate)}</td>
                      <td class="py-0.5 text-right tabular-nums">{fmtRate(dv.writeRate)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else if loadingDelta}
            <div class="mt-2 space-y-1 border-t border-edge pt-2" data-testid="disk-devs-skeleton" aria-hidden="true">
              <Skeleton height="12px" width="40%" />
              <Skeleton height="12px" width="55%" />
            </div>
          {/if}
        </section>

        <!-- ── Load average ── -->
        <section id="mon-load" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="gauge" size={14} /> {t("mon.loadHistory")}
            <span class="ml-auto h-2 w-2 rounded-full" style="background-color: {dotColor(loadLvl)}" data-testid="load-badge"></span>
          </h3>
          <div class="mb-1 flex items-end justify-between gap-3">
            <span class="text-2xl font-semibold tabular-nums {thresholdClass(metrics.load1, th.load)}">{metrics.load1?.toFixed(2) ?? "—"}</span>
            <Chart
              class="h-10 w-40"
              testid="load-history"
              max={Math.max(1, cores.length)}
              series={[
                { values: loadHist, color: C_LOAD, fill: true },
                { values: load5Hist, color: C_LOAD5 },
                { values: load15Hist, color: C_LOAD15 },
              ]}
            />
          </div>
          <div class="mb-2 flex gap-3 text-[11px] text-muted">
            <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-[2px]" style="background-color: {C_LOAD}"></span>1m</span>
            <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-[2px]" style="background-color: {C_LOAD5}"></span>5m</span>
            <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-[2px]" style="background-color: {C_LOAD15}"></span>15m</span>
          </div>
          <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt class="text-muted">{t("mon.load")}</dt>
            <dd class="text-right tabular-nums {thresholdClass(metrics.load1, th.load)}">
              {metrics.load1?.toFixed(2) ?? "—"} / {metrics.load5?.toFixed(2) ?? "—"} / {metrics.load15?.toFixed(2) ?? "—"}
            </dd>
            {#if detail?.psiCpu}
              <dt class="text-muted" use:tooltip={t("mon.psiCpuTitle")}>PSI CPU</dt>
              <dd class="text-right tabular-nums">{psiLabel(detail.psiCpu)}</dd>
            {/if}
            {#if detail?.procsRunning != null}
              <dt class="text-muted">{t("mon.procsRunBlk")}</dt>
              <dd class="text-right tabular-nums">{detail.procsRunning} / {detail.procsBlocked ?? 0}</dd>
            {/if}
          </dl>
          <p class="mt-1 text-[11px] text-muted">{t("mon.loadScaleNote", { n: cores.length || "?" })}</p>
        </section>

        <!-- ── Network ── -->
        <section id="mon-network" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="plug" size={14} /> {t("mon.network")}
            <span class="ml-auto h-2 w-2 rounded-full" style="background-color: {dotColor(netLvl)}"></span>
          </h3>
          <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt class="flex items-center gap-1 text-muted"><Icon name="download" size={12} /> {t("mon.rx")}</dt>
            <dd class="text-right tabular-nums">{fmtRate(metrics.netRxRate)}</dd>
            <dt class="flex items-center gap-1 text-muted"><Icon name="upload" size={12} /> {t("mon.tx")}</dt>
            <dd class="text-right tabular-nums">{fmtRate(metrics.netTxRate)}</dd>
            {#if metrics.netConns != null}
              <dt class="text-muted">{t("mon.connEstab")}</dt>
              <dd class="text-right tabular-nums">{metrics.netConns}</dd>
            {/if}
          </dl>
          <div class="mt-2 border-t border-edge pt-2">
            {#if netRxHist.length < 2}
              <p class="py-3 text-center text-[11px] text-muted">{t("mon.collecting")}</p>
            {:else}
              <Chart
                class="h-12 w-full"
                testid="net-history"
                series={[
                  { values: netRxHist, color: C_NET_RX },
                  { values: netTxHist, color: C_NET_TX },
                ]}
              />
              <div class="mt-1 flex gap-3 text-[11px] text-muted">
                <span class="flex items-center gap-1">
                  <span class="inline-block h-2 w-2 rounded-[2px]" style="background-color: {C_NET_RX}"></span>
                  {t("mon.rx")}</span
                >
                <span class="flex items-center gap-1">
                  <span class="inline-block h-2 w-2 rounded-[2px]" style="background-color: {C_NET_TX}"></span>
                  {t("mon.tx")}</span
                >
              </div>
            {/if}
          </div>
          {#if detail?.netIfaces && detail.netIfaces.length > 0}
            <div class="mt-2 border-t border-edge pt-2" data-testid="net-ifaces">
              <div class="mb-1 text-[11px] text-muted">{t("mon.interfaces")}</div>
              <table class="w-full text-[11px]">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="font-medium">{t("mon.iface")}</th>
                    <th class="text-right font-medium"><Icon name="download" size={11} class="ml-auto" /></th>
                    <th class="text-right font-medium"><Icon name="upload" size={11} class="ml-auto" /></th>
                    <th class="text-right font-medium">{t("mon.errDrop")}</th>
                  </tr>
                </thead>
                <tbody class="font-mono">
                  {#each detail.netIfaces as nf (nf.name)}
                    {@const errs = nf.rxErrs + nf.rxDrop + nf.txErrs + nf.txDrop}
                    <tr class="border-t border-edge/40">
                      <td class="truncate py-0.5 text-text">{nf.name}</td>
                      <td class="py-0.5 text-right tabular-nums">{fmtRate(nf.rxRate)}</td>
                      <td class="py-0.5 text-right tabular-nums">{fmtRate(nf.txRate)}</td>
                      <td class="py-0.5 text-right tabular-nums {errs > 0 ? 'text-warn' : 'text-muted'}"
                        >{errs.toLocaleString()}</td
                      >
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          {#if detail?.tcp && detail.tcp.length > 0}
            <div class="mt-2 border-t border-edge pt-2" data-testid="tcp-states">
              <div class="mb-1 text-[11px] text-muted">{t("mon.tcpStates")}</div>
              <StackedBar
                segments={detail.tcp.map((s, i) => ({
                  label: `${s.state}: ${s.count}`,
                  value: s.count,
                  color: TCP_COLORS[i % TCP_COLORS.length],
                }))}
              />
            </div>
          {/if}
          {#if detail?.sessions && detail.sessions.length > 0}
            <div class="mt-2 border-t border-edge pt-2" data-testid="sessions">
              <div class="mb-1 text-[11px] text-muted">{t("mon.sessionsLabel")}</div>
              <table class="w-full text-[11px]">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="font-medium">{t("mon.user")}</th>
                    <th class="font-medium">{t("mon.tty")}</th>
                    <th class="font-medium">{t("mon.from")}</th>
                  </tr>
                </thead>
                <tbody class="font-mono">
                  {#each detail.sessions as ss, i (i)}
                    <tr class="border-t border-edge/40">
                      <td class="py-0.5 text-text">{ss.user}</td>
                      <td class="py-0.5 text-muted">{ss.tty}</td>
                      <td class="truncate py-0.5 text-muted" title={ss.login}>{ss.from || "—"}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else if usersList.length > 0}
            <div class="mt-2 border-t border-edge pt-2 text-[11px] text-muted">
              {t("mon.users", { n: usersList.length })} <span class="text-text">{usersList.join(", ")}</span>
            </div>
          {/if}
        </section>

        <!-- ── Temperature (lm-sensors) ── -->
        <section id="mon-temp" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="thermometer" size={14} /> {t("mon.temperature")}
            {#if tempShown}
              <span class="ml-auto h-2 w-2 rounded-full" style="background-color: {dotColor(tempLvl)}"></span>
            {/if}
          </h3>
          {#if sensors.length > 0}
            {#if coreSensors.length >= 2}
              <div class="mb-2" data-testid="core-temps">
                <div class="mb-1 text-[11px] text-muted">{t("mon.coreTemps")}</div>
                <div class="flex h-10 items-end gap-0.5">
                  {#each coreSensors as c, i (i)}
                    <span
                      class="min-w-0 flex-1 rounded-[1px]"
                      title="{c.label}: {Math.round(c.temp)}°C"
                      style="height: {Math.max(8, sensorFill(c))}%; background-color: var({sensorLevel(c) === 'crit' ? '--color-danger' : sensorLevel(c) === 'warn' ? '--color-warn' : '--color-accent'})"
                    ></span>
                  {/each}
                </div>
              </div>
            {/if}
            <table class="w-full text-xs" data-testid="sensors-table">
              <thead>
                <tr class="text-left text-muted">
                  <th class="font-medium">{t("mon.sensor")}</th>
                  <th class="text-right font-medium">{t("mon.current")}</th>
                  <th class="text-right font-medium">{t("mon.high")}</th>
                  <th class="text-right font-medium">{t("mon.crit")}</th>
                </tr>
              </thead>
              <tbody>
                {#each sensors as s, i (i)}
                  <tr class="border-t border-edge/40">
                    <td class="truncate py-0.5 text-text" title={s.label}>{s.label}</td>
                    <td class="py-0.5 text-right tabular-nums {levelTextClass(sensorLevel(s))}">{Math.round(s.temp)}°C</td>
                    <td class="py-0.5 text-right tabular-nums text-muted">{s.high != null ? Math.round(s.high) + "°" : "—"}</td>
                    <td class="py-0.5 text-right tabular-nums text-muted">{s.crit != null ? Math.round(s.crit) + "°" : "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <div class="flex items-start gap-2 rounded border border-edge p-2" data-testid="sensors-install">
              <Icon name="info" size={15} class="mt-0.5 shrink-0 text-warn" />
              <div class="min-w-0 flex-1">
                <p class="text-xs text-text">{t("mon.sensorsUnavailable")}</p>
                <p class="mt-0.5 text-[11px] text-muted">{t("mon.sensorsHint")}</p>
                {#if onInstallTool}
                  <button
                    type="button"
                    onclick={() => onInstallTool?.("sensors")}
                    class="mt-2 rounded bg-edge px-3 py-1 text-xs font-medium hover:bg-accent hover:text-panel-alt"
                  >
                    {t("mon.installSensors")}
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        </section>

        <!-- ── Extras (lazy: GPU / Docker / SMART / OOM) ── -->
        {#if extras && (extras.gpus.length > 0 || extras.docker.length > 0 || extras.smart.length > 0 || (extras.oomKills ?? 0) > 0)}
          <section
            id="mon-extras"
            class="scroll-mt-2 rounded border border-edge bg-panel p-3"
            data-testid="extras-card"
          >
            <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
              <Icon name="activity" size={14} /> {t("mon.extras")}
              <span class="ml-auto h-2 w-2 rounded-full" style="background-color: {dotColor(extrasLvl)}"></span>
            </h3>
            {#if extras.gpus.length > 0}
              <div class="mb-2" data-testid="gpu-list">
                <div class="mb-1 text-[11px] text-muted">{t("mon.gpu")}</div>
                {#each extras.gpus as g, i (i)}
                  <div class="flex justify-between gap-2 text-[11px]">
                    <span class="truncate text-text" title={g.name}>{g.name}</span>
                    <span class="shrink-0 tabular-nums text-muted"
                      >{Math.round(g.util)}% · {g.memUsed}/{g.memTotal} MiB · {Math.round(g.temp)}°C</span
                    >
                  </div>
                {/each}
              </div>
            {/if}
            {#if extras.smart.length > 0}
              <div class="mb-2" data-testid="smart-list">
                <div class="mb-1 text-[11px] text-muted">{t("mon.smart")}</div>
                <table class="w-full text-[11px]">
                  <thead>
                    <tr class="text-left text-muted">
                      <th class="font-medium">{t("mon.device")}</th>
                      <th class="font-medium">{t("mon.health")}</th>
                      <th class="text-right font-medium">°C</th>
                      <th class="text-right font-medium">{t("mon.powerOn")}</th>
                    </tr>
                  </thead>
                  <tbody class="font-mono">
                    {#each extras.smart as d (d.device)}
                      <tr class="border-t border-edge/40">
                        <td class="py-0.5 text-text">{d.device}</td>
                        <td class="py-0.5 {d.health === 'PASSED' ? 'text-text' : 'text-danger'}">{d.health || "—"}</td>
                        <td class="py-0.5 text-right tabular-nums">{d.temp != null ? Math.round(d.temp) + "°" : "—"}</td>
                        <td class="py-0.5 text-right tabular-nums text-muted"
                          >{d.powerOnHours != null ? d.powerOnHours.toLocaleString() + " h" : "—"}</td
                        >
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
            {#if extras.docker.length > 0}
              <div class="mb-2" data-testid="docker-list">
                <div class="mb-1 text-[11px] text-muted">{t("mon.docker")}</div>
                {#each extras.docker as c, i (i)}
                  <div class="flex justify-between gap-2 text-[11px]">
                    <span class="truncate text-text" title={c.name}>{c.name}</span>
                    <span class="shrink-0 tabular-nums text-muted">{c.cpu.toFixed(1)}% · {c.mem}</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if extras.oomKills != null}
              <div class="flex justify-between border-t border-edge pt-2 text-[11px]" data-testid="oom-kills">
                <span class="text-muted">{t("mon.oomKills")}</span>
                <span class="tabular-nums {extras.oomKills > 0 ? 'text-danger' : 'text-text'}">{extras.oomKills}</span>
              </div>
            {/if}
          </section>
        {/if}
      </div>
    </div>
  {/if}
</Modal>
