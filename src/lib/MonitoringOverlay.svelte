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
  } from "./api";
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
  import { levelTextClass, thresholdClass, thresholdLevel, type ThresholdLevel } from "./thresholds";
  import { isHidden } from "./util";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import Chart from "./Chart.svelte";
  import StackedBar from "./StackedBar.svelte";
  import MetricTile from "./MetricTile.svelte";
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
    } catch {
      failed = true;
    }
  }

  // Pending updates are heavy: fetch once, lazily, AFTER the overlay has rendered.
  async function loadPending() {
    pendingLoading = true;
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
    extras = null;
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
  const loadCores = $derived(
    metrics?.load1 != null && cores.length > 0 ? metrics.load1 / cores.length : null,
  );

  function partPct(used: number, total: number): number | null {
    return total > 0 ? (used / total) * 100 : null;
  }
  const diskPct = $derived(
    metrics?.diskUsed != null && metrics?.diskTotal
      ? (metrics.diskUsed / metrics.diskTotal) * 100
      : null,
  );
  // A ~i64::MAX `fs.file-max` means "no limit": skip the percentage/threshold and
  // render the ceiling as ∞ instead of an astronomical number.
  const fdUnlimited = $derived(isUnlimitedLimit(detail?.fileNrMax ?? null));
  const fdPct = $derived(
    detail?.fileNrUsed != null && detail?.fileNrMax && !fdUnlimited
      ? (detail.fileNrUsed / detail.fileNrMax) * 100
      : null,
  );

  // Jump from a KPI tile to its detail section (expanding the page if needed).
  function focusSection(id: string) {
    settings.monitorExpanded = true;
    const reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() =>
      document
        .getElementById(id)
        ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }),
    );
  }
  const sensors = $derived(detail?.sensors ?? []);
  const coreSensors = $derived(sensors.filter((s) => /^core\s*\d+/i.test(s.label)));

  // A sensor breaches at its own crit/high first, else falls back to the CPU-temp
  // thresholds so a chip without published limits still gets coloured.
  function sensorLevel(s: { temp: number; high: number | null; crit: number | null }): ThresholdLevel {
    if (s.crit != null && s.temp >= s.crit) return "crit";
    if (s.high != null && s.temp >= s.high) return "warn";
    return thresholdLevel(s.temp, th.cpuTemp);
  }
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
  onclose={() => (open = false)}
>
  {#if !metrics && !failed}
    <!-- First paint before the first poll resolves. -->
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="monitoring-loading">
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
      <!-- System block (grouped static info) + density toggle -->
      <div class="mb-3 flex items-start gap-3">
        <section data-testid="system" class="min-w-0 flex-1 rounded border border-edge bg-panel p-3">
          <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Icon name={osIconFor(metrics)} size={16} class="text-muted" />
            <span class="text-sm text-text">{metrics.user || "—"}@{metrics.hostname || "—"}</span>
            <span class="text-xs text-muted">{metrics.prettyName || metrics.os || "—"}</span>
          </div>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            {#if metrics.kernel}{@render sysField(t("mon.kernel"), metrics.kernel)}{/if}
            {#if metrics.uptimeSecs != null}{@render sysField(t("mon.uptimeLabel"), fmtUptime(metrics.uptimeSecs))}{/if}
            {#if metrics.ip}{@render sysField(t("mon.ipLabel"), metrics.ip)}{/if}
            {#if metrics.serverTime}{@render sysField(t("mon.serverTimeLabel"), metrics.serverTime)}{/if}
            {#if cores.length > 0}{@render sysField(t("mon.coresLabel"), String(cores.length))}{/if}
            {#if detail?.timeSynced != null}{@render sysField(t("mon.timeSync"), detail.timeSynced ? t("mon.synced") : t("mon.notSynced"), detail.timeSynced ? undefined : "text-warn")}{/if}
            {#if detail?.failedUnits != null}{@render sysField(t("mon.failedUnits"), String(detail.failedUnits), detail.failedUnits > 0 ? "text-danger" : undefined)}{/if}
            {#if detail?.listenPorts != null}{@render sysField(t("mon.listening"), String(detail.listenPorts))}{/if}
            {#if detail?.conntrack != null}{@render sysField(t("mon.conntrack"), detail.conntrackMax ? `${detail.conntrack} / ${detail.conntrackMax}` : String(detail.conntrack))}{/if}
          </dl>
        </section>
        <div
          role="group"
          aria-label={t("mon.title")}
          class="flex shrink-0 overflow-hidden rounded border border-edge text-xs"
        >
          <button
            type="button"
            onclick={() => (settings.monitorExpanded = false)}
            aria-pressed={!settings.monitorExpanded}
            class="px-2 py-1 {!settings.monitorExpanded
              ? 'bg-edge text-text'
              : 'text-muted hover:text-accent'}">{t("mon.compact")}</button
          >
          <button
            type="button"
            onclick={() => (settings.monitorExpanded = true)}
            aria-pressed={settings.monitorExpanded}
            class="px-2 py-1 {settings.monitorExpanded
              ? 'bg-edge text-accent'
              : 'text-muted hover:text-accent'}">{t("mon.detailed")}</button
          >
        </div>
      </div>

      <!-- KPI tiles — always visible (compact + detailed) -->
      <div class="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" data-testid="kpi-tiles">
        <MetricTile
          icon="cpu"
          label={t("mon.cpu")}
          level={thresholdLevel(cpu, th.cpu)}
          gaugeFill={cpu}
          gaugeText={fmtPct(cpu)}
          history={cpuHist}
          historyColor={C_CPU}
          onclick={() => focusSection("mon-cpu")}
          testid="tile-cpu"
        />
        <MetricTile
          icon="memory"
          label={t("mon.memory")}
          level={thresholdLevel(ramPct, th.ram)}
          gaugeFill={ramPct}
          gaugeText={fmtPct(ramPct)}
          history={ramHist}
          historyColor={C_RAM}
          onclick={() => focusSection("mon-memory")}
          testid="tile-ram"
        />
        <MetricTile
          icon="disk"
          label={t("mon.diskLabel")}
          level={thresholdLevel(diskPct, th.disk)}
          gaugeFill={diskPct}
          gaugeText={fmtPct(diskPct)}
          sub="{fmtBytes(metrics.diskUsed)} / {fmtBytes(metrics.diskTotal)}"
          onclick={() => focusSection("mon-fs")}
          testid="tile-disk"
        />
        <MetricTile
          icon="gauge"
          label={t("mon.loadLabel")}
          level={thresholdLevel(metrics.load1, th.load)}
          big={metrics.load1?.toFixed(2) ?? "—"}
          history={loadHist}
          historyMax={Math.max(1, cores.length)}
          historyColor={C_LOAD}
          sub="{metrics.load5?.toFixed(2) ?? '—'} / {metrics.load15?.toFixed(2) ?? '—'}"
          onclick={() => focusSection("mon-load")}
          testid="tile-load"
        />
        {#if metrics.cpuTemp != null}
          <MetricTile
            icon="thermometer"
            label={t("mon.temperature")}
            level={thresholdLevel(metrics.cpuTemp, th.cpuTemp)}
            gaugeFill={metrics.cpuTemp}
            gaugeText="{Math.round(metrics.cpuTemp)}°"
            onclick={() => focusSection("mon-temp")}
            testid="tile-temp"
          />
        {/if}
        <MetricTile
          icon="download"
          label={t("mon.network")}
          big={fmtRate(metrics.netRxRate)}
          sub="{t('mon.tx')} {fmtRate(metrics.netTxRate)}"
          onclick={() => focusSection("mon-network")}
          testid="tile-net"
        />
      </div>

      {#if settings.monitorExpanded}
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="detail-sections">
        <!-- ── CPU ── -->
        <section id="mon-cpu" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="cpu" size={14} /> {t("mon.cpu")}
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
          {/if}
          <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt class="text-muted">{t("mon.load")}</dt>
            <dd class="text-right tabular-nums {thresholdClass(metrics.load1, th.load)}">
              {metrics.load1?.toFixed(2) ?? "—"} / {metrics.load5?.toFixed(2) ?? "—"} / {metrics.load15?.toFixed(2) ?? "—"}
            </dd>
            {#if loadCores != null}
              <dt class="text-muted">{t("mon.loadPerCore")}</dt>
              <dd class="text-right tabular-nums">{loadCores.toFixed(2)}</dd>
            {/if}
            {#if detail?.psiCpu}
              <dt class="text-muted" title={t("mon.psiCpuTitle")}>PSI CPU</dt>
              <dd class="text-right tabular-nums">{psiLabel(detail.psiCpu)}</dd>
            {/if}
            {#if detail?.ctxtRate != null}
              <dt class="text-muted">{t("mon.ctxSwitch")}</dt>
              <dd class="text-right tabular-nums">{detail.ctxtRate.toLocaleString()}</dd>
            {/if}
            {#if detail?.intrRate != null}
              <dt class="text-muted">{t("mon.interrupts")}</dt>
              <dd class="text-right tabular-nums">{detail.intrRate.toLocaleString()}</dd>
            {/if}
            {#if detail?.procsRunning != null}
              <dt class="text-muted">{t("mon.procsRunBlk")}</dt>
              <dd class="text-right tabular-nums">{detail.procsRunning} / {detail.procsBlocked ?? 0}</dd>
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

        <!-- ── Temperature (lm-sensors) ── -->
        <section id="mon-temp" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="thermometer" size={14} /> {t("mon.temperature")}
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

        <!-- ── Memory ── -->
        <section id="mon-memory" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="memory" size={14} /> {t("mon.memory")}
          </h3>
          <div class="mb-2 flex items-end justify-between gap-3">
            <span class="text-2xl font-semibold tabular-nums {thresholdClass(ramPct, th.ram)}">{fmtPct(ramPct)}</span>
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
            <dt class="text-muted">{t("mon.used")}</dt>
            <dd class="text-right tabular-nums">{fmtBytes(metrics.memUsed)} / {fmtBytes(metrics.memTotal)}</dd>
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
          {#if topMemProcs.length > 0}
            <div class="mt-2 border-t border-edge pt-2 text-[11px] text-muted">
              {t("mon.topMem")} <span class="text-text">{topMemProcs.join(", ")}</span>
            </div>
          {/if}
        </section>

        <!-- ── Filesystems / descriptors ── -->
        <section id="mon-fs" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="disk" size={14} /> {t("mon.filesystems")}
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
              <dt class="text-muted" title={t("mon.descriptorsTitle")}>{t("mon.descriptors")}</dt>
              <dd class="text-right tabular-nums {thresholdClass(fdPct, th.fd)}">
                {detail.fileNrUsed.toLocaleString()} / {fmtLimit(detail.fileNrMax)} ({fmtPct(fdPct)})
              </dd>
            {/if}
            {#if detail?.ulimitSoft != null}
              <dt class="text-muted" title={t("mon.ulimitTitle")}>ulimit -n</dt>
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
          {/if}
        </section>

        <!-- ── Network ── -->
        <section id="mon-network" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="plug" size={14} /> {t("mon.network")}
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

        <!-- ── Load history ── -->
        <section id="mon-load" class="scroll-mt-2 rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="gauge" size={14} /> {t("mon.loadHistory")}
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
          <div class="mb-1 flex gap-3 text-[11px] text-muted">
            <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-[2px]" style="background-color: {C_LOAD}"></span>1m</span>
            <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-[2px]" style="background-color: {C_LOAD5}"></span>5m</span>
            <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-[2px]" style="background-color: {C_LOAD15}"></span>15m</span>
          </div>
          <p class="text-[11px] text-muted">{t("mon.loadScaleNote", { n: cores.length || "?" })}</p>
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

        <!-- ── Updates (lazy) ── -->
        <section id="mon-updates" class="scroll-mt-2 rounded border border-edge bg-panel p-3" data-testid="updates-card">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="refresh" size={14} /> {t("mon.updates")}
          </h3>
          {#if pendingLoading}
            <Skeleton height="20px" width="60%" />
          {:else if pending && pending.manager}
            <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt class="text-muted">{t("mon.manager")}</dt>
              <dd class="text-right">{pending.manager}</dd>
              <dt class="text-muted">{t("mon.updatesAvailable")}</dt>
              <dd class="text-right tabular-nums {(pending.updates ?? 0) > 0 ? 'text-warn' : ''}">{pending.updates ?? "—"}</dd>
              {#if pending.security != null}
                <dt class="text-muted">{t("mon.security")}</dt>
                <dd class="text-right tabular-nums {(pending.security ?? 0) > 0 ? 'text-danger' : ''}">{pending.security}</dd>
              {/if}
              <dt class="text-muted">{t("mon.rebootRequired")}</dt>
              <dd class="text-right {pending.rebootRequired ? 'text-danger' : ''}">{pending.rebootRequired ? t("mon.yes") : t("mon.no")}</dd>
            </dl>
          {:else}
            <p class="text-xs text-muted">{t("mon.pmUnknown")}</p>
          {/if}
        </section>
      </div>
      {/if}
    </div>
  {/if}
</Modal>
