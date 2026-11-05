<script lang="ts">
  import { untrack } from "svelte";
  // The monitoring page (v1.33): a navigation of sections on the left — each with
  // its short value and the level of its worst problem — and the chosen section on
  // the right, the overview first. Data is fetched only while the page is open:
  // the poll loop starts on open and stops on close, so a closed page costs
  // nothing on the server. The heavy probes (pending updates, extras) run once,
  // after the first paint; GPUs and containers are polled live only while their
  // section is on screen. Every poll's readings go into one history
  // (monhistory.ts), which every chart draws from.
  //
  // The basic probe is the session's one feed (stores/metricsfeed, v1.34): the
  // page rides its beat with the detail probe as a companion, and opens with the
  // history the feed has kept since the tab connected.
  import {
    fetchExtras,
    fetchLiveExtras,
    fetchMetricsDetail,
    fetchPendingUpdates,
    type Extras,
    type LiveExtras,
    type Metrics,
    type MetricsDetail,
    type PendingUpdates,
  } from "../api";
  import { feedOf, watchMetrics } from "../stores/metricsfeed.svelte";
  import { settings } from "../settings/settings.svelte";
  import { metricsSnapshot } from "../ai/aimetrics";
  import Modal from "../ui/Modal.svelte";
  import Icon from "../ui/Icon.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import MonOverview from "./MonOverview.svelte";
  import MonCpu from "./MonCpu.svelte";
  import MonMemory from "./MonMemory.svelte";
  import MonDisks from "./MonDisks.svelte";
  import MonNetwork from "./MonNetwork.svelte";
  import MonTemperature from "./MonTemperature.svelte";
  import MonProcesses from "./MonProcesses.svelte";
  import MonContainers from "./MonContainers.svelte";
  import MonGpu from "./MonGpu.svelte";
  import MonSystem from "./MonSystem.svelte";
  import { osIconFor } from "./format";
  import { pushReadings, readingsOf, type History } from "./monhistory";
  import { baselineOf, problems, sectionLevels, type Baseline, type SectionId } from "./monproblems";
  import {
    navValue,
    SECTION_ICON,
    SECTION_LABEL,
    shownSections,
    wantsLive,
    type AskFocus,
    type MonActions,
    type MonView,
  } from "./monsections";
  import { levelDot } from "./monpalette";
  import { t } from "../i18n";

  let {
    open = $bindable(false),
    section = $bindable("overview"),
    sessionId,
    onInstallTool,
    onAskAi,
    onRunInTerminal,
    onOpenDocker,
  }: {
    open?: boolean;
    /** The section on screen; set before opening to open the page on it (the status bar does). */
    section?: SectionId;
    sessionId: string;
    /** Offer to install a server tool (e.g. "sensors") via the Phase 12.8 flow. */
    onInstallTool?: (toolName: string) => void;
    /** Hand a metrics snapshot to the AI assistant (Phase 41). */
    onAskAi?: (snapshot: string) => void;
    /** Type a read-only command into the session's terminal. */
    onRunInTerminal?: (argv: string[]) => void;
    /** Show the Docker panel (offered only when the panel is not hidden). */
    onOpenDocker?: () => void;
  } = $props();

  let metrics = $state<Metrics | null>(null);
  let detail = $state<MetricsDetail | null>(null);
  let failed = $state(false);
  let pending = $state<PendingUpdates | null>(null);
  let pendingLoading = $state(false);
  let extras = $state<Extras | null>(null);
  let live = $state<LiveExtras | null>(null);
  // Successful polls so far. Delta metrics (per-core, CPU breakdown, rates) need
  // two samples, so they are skeletons while pollCount < 2.
  let pollCount = $state(0);
  let hist = $state.raw<History>({});
  let seq = $state(-1);
  let baseline = $state.raw<Baseline | null>(null);
  // The beat of the feed while the page rides it with its detail probe.
  const interval = $derived(Math.max(2, settings.statusPollInterval));

  type Companion = [MetricsDetail, LiveExtras | null];
  // The detail (and, on the GPU or Containers section, the live probe) fetched in
  // the feed's tick. The live probe failing alone does not fail the poll.
  function companion(id: string): Promise<Companion> {
    const liveWanted = wantsLive(section);
    return Promise.all([
      fetchMetricsDetail(id, section === "processes"),
      liveWanted ? fetchLiveExtras(id).catch(() => null) : Promise.resolve(null),
    ]);
  }

  /** One tick of the feed: `n` is the poll's number, −1 for the answer fetched on opening. */
  function onPoll(m: Metrics | null, x: Companion | null, n: number) {
    if (!m || !x) {
      failed = true;
      return;
    }
    const [d, l] = x;
    metrics = m;
    detail = d;
    if (l) live = l;
    failed = false;
    baseline ??= baselineOf(d);
    if (n >= 0) {
      seq = n;
      hist = pushReadings(hist, n, readingsOf(m, d, l));
    }
    pollCount += 1;
  }

  // Pending updates and extras are heavy: once, after the page has painted.
  async function loadPending() {
    try {
      pending = await fetchPendingUpdates(sessionId);
    } catch {
      pending = null;
    } finally {
      pendingLoading = false;
    }
  }
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
    live = null;
    pollCount = 0;
    failed = false;
    hist = {};
    seq = -1;
    baseline = null;
    section = "overview";
  }

  // Watch the feed while the page is open. It opens with what the feed already
  // has — the newest reading and the history since the tab connected.
  $effect(() => {
    if (!open) {
      reset();
      return;
    }
    const id = sessionId;
    pendingLoading = true;
    // The companion reads the section it is on (for the live probe) — not a
    // reason to watch again when the section changes.
    const stop = untrack(() => {
      const f = feedOf(id);
      metrics = f.metrics;
      hist = f.hist;
      seq = f.seq;
      return watchMetrics<Companion>(id, { companion: () => companion(id), done: onPoll });
    });
    const pendingTimer = setTimeout(loadPending, 300);
    const extrasTimer = setTimeout(loadExtras, 400);
    return () => {
      stop();
      clearTimeout(pendingTimer);
      clearTimeout(extrasTimer);
    };
  });

  // Arriving at Processes: the full list at once rather than at the next tick.
  // Not pushed to the history — a sample off the beat would bend the time axis.
  $effect(() => {
    if (!open || section !== "processes") return;
    const id = sessionId;
    fetchMetricsDetail(id, true)
      .then((d) => {
        if (open && id === sessionId && section === "processes") detail = d;
      })
      .catch(() => {});
  });

  // Arriving at the GPU or Containers section: one live reading at once rather
  // than waiting for the next tick.
  $effect(() => {
    if (!open || !wantsLive(section)) return;
    const id = sessionId;
    fetchLiveExtras(id)
      .then((l) => {
        if (open && id === sessionId) live = l;
      })
      .catch(() => {});
  });

  const th = $derived(settings.statusBarThresholds);
  const probs = $derived(problems({ metrics, detail, extras, pending, th, baseline }));
  const levels = $derived(sectionLevels(probs));
  const data = $derived({ metrics, detail, extras, live });
  const sections = $derived(shownSections(data));
  const current = $derived<SectionId>(sections.includes(section) ? section : "overview");
  const overallText = $derived(
    levels.overview === "crit" ? t("mon.healthCrit") : levels.overview === "warn" ? t("mon.healthWarn") : t("mon.healthOk"),
  );

  const view = $derived<MonView | null>(
    metrics
      ? {
          sessionId,
          metrics,
          detail,
          extras,
          live,
          pending,
          pendingLoading,
          hist,
          seq,
          interval,
          th,
          problems: probs,
          levels,
          loadingDelta: pollCount < 2,
          baseline,
        }
      : null,
  );

  const actions = $derived<MonActions>({
    go: (s) => (section = s),
    ask: onAskAi
      ? (focus: AskFocus) => {
          if (!metrics) return;
          onAskAi(metricsSnapshot(metrics, detail, { extras, problems: probs, focus }));
          open = false;
        }
      : undefined,
    run: onRunInTerminal
      ? (argv: string[]) => {
          onRunInTerminal(argv);
          open = false;
        }
      : undefined,
    installTool: onInstallTool,
    openDocker: onOpenDocker
      ? () => {
          onOpenDocker();
          open = false;
        }
      : undefined,
  });
</script>

<Modal {open} title={t("mon.title")} width="w-[min(96vw,1180px)]" showClose onclose={() => (open = false)}>
  {#if !metrics && !failed}
    <div class="grid h-[min(78vh,760px)] grid-cols-[11rem_minmax(0,1fr)] gap-3" data-testid="monitoring-loading">
      <Skeleton height="100%" class="rounded" />
      <div class="grid content-start gap-2 md:grid-cols-2">
        {#each Array(4) as _, i (i)}<Skeleton height="140px" class="rounded" />{/each}
      </div>
    </div>
  {:else if !metrics}
    <p class="py-8 text-center text-sm text-danger">{t("mon.fetchFailed")}</p>
  {:else if view}
    <div class="grid h-[min(78vh,760px)] grid-cols-[11rem_minmax(0,1fr)] gap-3">
      <nav aria-label={t("mon.sections")} class="flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-edge pr-2" data-testid="mon-nav">
        <div class="mb-1.5 border-b border-edge px-1.5 pb-2">
          <div class="flex items-center gap-1.5">
            <Icon name={osIconFor(metrics)} size={14} class="shrink-0 text-muted" />
            <span class="truncate text-xs font-semibold text-text">{metrics.hostname || "—"}</span>
          </div>
          <div class="truncate text-meta text-muted">{metrics.prettyName || metrics.os || "—"}</div>
          <div class="mt-1 flex items-center gap-1.5 text-meta" data-testid="mon-overall" data-level={levels.overview}>
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background-color: {levelDot(levels.overview)}"></span>
            <span class={levels.overview === "crit" ? "text-bad" : levels.overview === "warn" ? "text-warn" : "text-ok"}>{overallText}</span>
          </div>
          {#if failed}
            <div class="mt-1 text-meta text-warn">{t("mon.refreshFailed")}</div>
          {/if}
        </div>
        {#each sections as s (s)}
          {@const value = navValue(s, data)}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs {current === s
              ? 'bg-edge text-text'
              : 'text-muted hover:bg-edge/50 hover:text-text'}"
            aria-current={current === s ? "page" : undefined}
            data-testid="mon-nav-{s}"
            data-level={levels[s]}
            onclick={() => (section = s)}
          >
            <Icon name={SECTION_ICON[s]} size={14} class="shrink-0 {current === s ? 'text-accent' : ''}" />
            <span class="min-w-0 flex-1 truncate">{t(SECTION_LABEL[s])}</span>
            {#if value}<span class="shrink-0 text-meta tabular-nums text-muted">{value}</span>{/if}
            {#if s !== "overview" && levels[s] !== "ok"}
              <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background-color: {levelDot(levels[s])}"></span>
            {/if}
          </button>
        {/each}
      </nav>
      <div class="min-h-0 min-w-0 overflow-y-auto pr-1" data-testid="mon-section-{current}">
        {#if current === "overview"}
          <MonOverview v={view} a={actions} />
        {:else if current === "cpu"}
          <MonCpu v={view} a={actions} />
        {:else if current === "memory"}
          <MonMemory v={view} a={actions} />
        {:else if current === "disks"}
          <MonDisks v={view} a={actions} />
        {:else if current === "network"}
          <MonNetwork v={view} a={actions} />
        {:else if current === "temperature"}
          <MonTemperature v={view} a={actions} />
        {:else if current === "processes"}
          <MonProcesses v={view} a={actions} />
        {:else if current === "containers"}
          <MonContainers v={view} a={actions} />
        {:else if current === "gpu"}
          <MonGpu v={view} a={actions} />
        {:else}
          <MonSystem v={view} a={actions} />
        {/if}
      </div>
    </div>
  {/if}
</Modal>
