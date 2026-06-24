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
    type Metrics,
    type MetricsDetail,
    type PendingUpdates,
    type Psi,
  } from "./api";
  import { fmtBytes, fmtPct, fmtRate, fmtUptime, memPct, osIconFor } from "./format";
  import { settings } from "./settings.svelte";
  import { thresholdClass } from "./thresholds";
  import { isHidden } from "./util";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import Sparkline from "./Sparkline.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { t } from "./i18n";

  let {
    open = $bindable(false),
    sessionId,
  }: {
    open?: boolean;
    sessionId: string;
  } = $props();

  let metrics = $state<Metrics | null>(null);
  let detail = $state<MetricsDetail | null>(null);
  let failed = $state(false);
  let pending = $state<PendingUpdates | null>(null);
  let pendingLoading = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  // Rolling histories (built up from the moment the overlay opens).
  const HISTORY = 40;
  let cpuHist = $state<number[]>([]);
  let ramHist = $state<number[]>([]);
  let swapHist = $state<number[]>([]);
  let loadHist = $state<number[]>([]);

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

  function reset() {
    metrics = null;
    detail = null;
    pending = null;
    failed = false;
    cpuHist = [];
    ramHist = [];
    swapHist = [];
    loadHist = [];
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
    // Defer the heavy pending-updates probe so the page paints first.
    const pendingTimer = setTimeout(loadPending, 300);
    timer = setInterval(poll, everyMs);
    return () => {
      clearInterval(timer);
      clearTimeout(pendingTimer);
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
  const fdPct = $derived(
    detail?.fileNrUsed != null && detail?.fileNrMax
      ? (detail.fileNrUsed / detail.fileNrMax) * 100
      : null,
  );
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
    <!-- Header -->
    <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span class="flex items-center gap-2 text-sm text-text">
        <Icon name={osIconFor(metrics)} size={16} class="text-muted" />
        {metrics.user || "—"}@{metrics.hostname || "—"}
      </span>
      <span>{metrics.prettyName || metrics.os || "—"}</span>
      {#if metrics.kernel}<span class="flex items-center gap-1"><Icon name="terminal" size={13} />{metrics.kernel}</span>{/if}
      {#if metrics.uptimeSecs != null}<span class="flex items-center gap-1"><Icon name="power" size={13} />{fmtUptime(metrics.uptimeSecs)}</span>{/if}
      {#if metrics.ip}<span class="flex items-center gap-1"><Icon name="globe" size={13} />{metrics.ip}</span>{/if}
      {#if metrics.serverTime}<span class="flex items-center gap-1"><Icon name="clock" size={13} />{metrics.serverTime}</span>{/if}
    </div>

    <div class="max-h-[78vh] overflow-y-auto pr-1">
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <!-- ── CPU ── -->
        <section class="rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="cpu" size={14} /> {t("mon.cpu")}
          </h3>
          <div class="mb-2 flex items-end justify-between">
            <span class="text-2xl font-semibold tabular-nums {thresholdClass(cpu, th.cpu)}">{fmtPct(cpu)}</span>
            <Sparkline values={cpuHist} testid="cpu-history" class="h-10 w-40" />
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
          {#if topCpuProcs.length > 0}
            <div class="mt-2 border-t border-edge pt-2 text-[11px] text-muted">
              {t("mon.topCpu")} <span class="text-text">{topCpuProcs.join(", ")}</span>
            </div>
          {/if}
        </section>

        <!-- ── Memory ── -->
        <section class="rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="memory" size={14} /> {t("mon.memory")}
          </h3>
          <div class="mb-2 flex items-end justify-between">
            <span class="text-2xl font-semibold tabular-nums {thresholdClass(ramPct, th.ram)}">{fmtPct(ramPct)}</span>
            <Sparkline values={ramHist} color="#89b4fa" class="h-10 w-40" />
          </div>
          <div class="mb-2 h-2 w-full overflow-hidden rounded-full bg-edge">
            <span class="block h-full rounded-full bg-accent" style="width: {ramPct ?? 0}%"></span>
          </div>
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
        <section class="rounded border border-edge bg-panel p-3">
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
                {detail.fileNrUsed.toLocaleString()} / {detail.fileNrMax?.toLocaleString()} ({fmtPct(fdPct)})
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
        </section>

        <!-- ── Network ── -->
        <section class="rounded border border-edge bg-panel p-3">
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
          {#if detail?.tcp && detail.tcp.length > 0}
            <div class="mt-2 border-t border-edge pt-2" data-testid="tcp-states">
              <div class="mb-1 text-[11px] text-muted">{t("mon.tcpStates")}</div>
              <div class="flex flex-wrap gap-1">
                {#each detail.tcp as tcp (tcp.state)}
                  <span class="rounded bg-edge px-1.5 py-0.5 text-[11px] tabular-nums">{tcp.state}: {tcp.count}</span>
                {/each}
              </div>
            </div>
          {/if}
          {#if usersList.length > 0}
            <div class="mt-2 border-t border-edge pt-2 text-[11px] text-muted">
              {t("mon.users", { n: usersList.length })} <span class="text-text">{usersList.join(", ")}</span>
            </div>
          {/if}
        </section>

        <!-- ── Load history ── -->
        <section class="rounded border border-edge bg-panel p-3">
          <h3 class="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <Icon name="gauge" size={14} /> {t("mon.loadHistory")}
          </h3>
          <div class="mb-1 flex items-end justify-between">
            <span class="text-2xl font-semibold tabular-nums {thresholdClass(metrics.load1, th.load)}">{metrics.load1?.toFixed(2) ?? "—"}</span>
            <Sparkline values={loadHist} max={Math.max(1, cores.length)} color="#f9e2af" class="h-10 w-40" />
          </div>
          <p class="text-[11px] text-muted">{t("mon.loadScaleNote", { n: cores.length || "?" })}</p>
        </section>

        <!-- ── Updates (lazy) ── -->
        <section class="rounded border border-edge bg-panel p-3" data-testid="updates-card">
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
    </div>
  {/if}
</Modal>
