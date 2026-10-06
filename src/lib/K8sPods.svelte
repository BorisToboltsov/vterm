<script lang="ts">
  // Pod list for the k8s panel (Phase 37), grouped by owning workload (Deployment /
  // StatefulSet / DaemonSet / Job, ReplicaSets rolled up to Deployments) — the
  // analogue of DockerContainers' compose grouping. Each row shows status, ready,
  // restarts, live CPU/mem (when metrics-server is present) and age; a right-click
  // menu + hover buttons drive actions. Presentational + action wiring only; arg
  // building is pure (k8s.ts), the orchestrator's `run` executes.
  import Icon from "./Icon.svelte";
  import Sparkline from "./Sparkline.svelte";
  import { tooltip } from "./actions/tooltip";
  import { historyMax, padHistory, type LoadHistory } from "./loadhistory";
  import {
    deleteArgs,
    metricsKey,
    podPhaseTone,
    parseCpuMillis,
    parseMemMiB,
    limitRatio,
    limitTone,
    type PodGroup,
    type K8sPod,
    type K8sPodMetrics,
  } from "./k8s";
  import type { IconName } from "./icons";
  import type { MenuItem } from "./ctxmenu";
  import ColumnHead from "./ColumnHead.svelte";
  import { columnVars } from "./colwidths";
  import { columns } from "./stores/colwidths.svelte";
  import { t } from "./i18n";

  let {
    groups,
    metricsByKey,
    cpuHistory = {},
    busy = false,
    run,
    openShell,
    onViewDetails,
    showMenu,
  }: {
    groups: PodGroup[];
    /** Live `kubectl top pods` snapshot keyed by {@link metricsKey}. */
    metricsByKey: Map<string, K8sPodMetrics>;
    /** Rolling CPU history (millicores) keyed by {@link metricsKey} (Phase 42). */
    cpuHistory?: LoadHistory;
    busy?: boolean;
    run: (bareArgs: string[], namespace: string, opts?: { successKey?: string }) => Promise<boolean>;
    openShell: (pod: K8sPod, container: string | null) => void;
    onViewDetails: (pod: K8sPod) => void;
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  const TONE: Record<string, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    idle: "bg-muted",
  };
  const KIND_ICON: Record<string, IconName> = {
    Deployment: "rocket",
    StatefulSet: "database",
    DaemonSet: "container",
    Job: "refresh",
    CronJob: "refresh",
  };

  // The resizable columns of the wide layout → the CSS variables their cells read.
  const COLS = {
    "--c-name": "k8s.name",
    "--c-ns": "k8s.namespace",
    "--c-node": "k8s.node",
  } as const;
  // The list's visible height: a column's border can be dragged anywhere along
  // it, so the grip in the header reaches this far down (ColumnGrip, `--list-h`).
  let listHeight = $state(0);
  // Table cells of the wide layout. The row stretches its cells and has no
  // vertical padding there, so a cell's rule runs the full height of the row.
  // TEXT: a resizable column on the left, ruled on its right — under the header
  // border that is dragged. NUM: a fixed-width figure on the right, ruled on its left.
  const TEXT = "@wide:border-r @wide:border-edge/40 @wide:py-1.5 @wide:leading-4";
  const NUM =
    "@wide:shrink-0 @wide:border-l @wide:border-edge/40 @wide:px-2 @wide:py-1.5 @wide:leading-4";
  // The CPU figure: no rule of its own — it continues the cell with the CPU shape.
  const CPU = "@wide:order-2 @wide:shrink-0 @wide:px-2 @wide:py-1.5 @wide:leading-4";
  // The CPU shape precedes the figures in the markup (a narrow row draws it
  // first) but belongs next to the CPU figure in the table. `order` moves it:
  // ready and restarts keep 0, the shape takes 1, everything after it takes 2.
  const LATE = "@wide:order-2";
  // The header's twin of NUM (the header is only drawn wide, so no variant).
  const HEAD = "shrink-0 truncate border-l border-edge px-2 py-1";

  function metrics(p: K8sPod): K8sPodMetrics | undefined {
    return metricsByKey.get(metricsKey(p.namespace, p.name)) ?? metricsByKey.get(metricsKey("", p.name));
  }

  function copyName(p: K8sPod) {
    void navigator.clipboard?.writeText(p.name);
  }

  const TONE_TEXT: Record<string, string> = { ok: "text-muted", warn: "text-warn", bad: "text-bad" };
  const TONE_BAR: Record<string, string> = { ok: "bg-accent", warn: "bg-warn", bad: "bg-bad" };

  /** Usage-vs-limit for one resource, or null when the pod is unbounded. */
  function usage(used: number | null, limit: number | null) {
    const ratio = limitRatio(used, limit);
    if (ratio == null) return null;
    return { ratio, pct: Math.min(100, ratio * 100), tone: limitTone(ratio) ?? "ok" };
  }

  function menuItems(p: K8sPod): MenuItem[] {
    return [
      { icon: "eye", label: t("k8s.viewDetails"), onSelect: () => onViewDetails(p) },
      { icon: "terminal", label: t("k8s.openShell"), onSelect: () => openShell(p, p.containers.length > 1 ? p.containers[0] : null) },
      { kind: "separator" },
      { icon: "copy", label: t("k8s.copyName"), onSelect: () => copyName(p) },
      { icon: "trash", label: t("k8s.delete"), danger: true, onSelect: () => run(deleteArgs("pod", p.name), p.namespace, { successKey: "k8s.deleted" }) },
    ];
  }
</script>

<!-- The column widths are CSS variables on the list: the header and every row
     read the same ones, so dragging a border is one style write, not one per row. -->
<div
  class="h-full overflow-auto text-xs"
  bind:clientHeight={listHeight}
  style="{columnVars(columns.widths, COLS)}{listHeight > 0 ? `; --list-h: ${listHeight}px` : ''}"
>
  <!-- Column titles — only where there are columns, i.e. in a wide container. The
       header repeats a row's cells one for one (same widths, padding and rules),
       so its borders stand exactly over the rows' and shrink the same way. -->
  <div
    class="sticky top-0 z-10 hidden items-stretch border-b border-edge bg-panel-alt pl-2.5 pr-2 text-meta font-medium text-muted @wide:flex"
    data-testid="k8s-columns"
  >
    <span class="mr-2 w-[7px] shrink-0"></span>
    <ColumnHead col="k8s.name" label={t("k8s.name")} class="w-[var(--c-name)] pr-2" />
    <ColumnHead col="k8s.namespace" label={t("k8s.namespace")} class="w-[var(--c-ns)] px-2" />
    <ColumnHead col="k8s.node" label={t("k8s.node")} class="w-[var(--c-node)] px-2" />
    <span class="flex-1"></span>
    <span class="{HEAD} w-16 text-right">{t("k8s.ready")}</span>
    <span class="{HEAD} w-12 text-right" use:tooltip={t("k8s.restarts")}>↻</span>
    <!-- CPU is two cells in a row — the shape, then the figure — under one title. -->
    <span class="w-[3.25rem] shrink-0 border-l border-edge"></span>
    <span class="w-20 shrink-0 truncate px-2 py-1 text-right">{t("k8s.cpu")}</span>
    <span class="{HEAD} w-20 text-right">{t("k8s.mem")}</span>
    <span class="{HEAD} w-28">{t("k8s.limits")}</span>
    <span class="{HEAD} w-18 text-right">{t("k8s.age")}</span>
    <span class="w-14 shrink-0 border-l border-edge"></span>
  </div>
  {#each groups as g (`${g.kind}/${g.name}`)}
    <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
      {#if g.name}
        <Icon name={KIND_ICON[g.kind] ?? "cloud"} size={13} class="text-accent" />
        <span class="min-w-0 flex-1 truncate font-medium text-text/85">{g.name}</span>
        <span class="shrink-0 text-caption uppercase tracking-wider text-muted">{g.kind}</span>
      {:else}
        <span class="text-caption uppercase tracking-wider text-muted">{t("k8s.standalone")}</span>
      {/if}
    </div>

    {#each g.pods as p (`${p.namespace}/${p.name}`)}
      {@const m = metrics(p)}
      {@const history = cpuHistory[metricsKey(p.namespace, p.name)] ?? []}
      <!-- One markup, two layouts. Narrow: a flex row — name, then a ragged
           cluster of figures. Wide (`@wide:`): a table row — the cluster dissolves
           (`contents`) so each figure becomes a cell of the row with a fixed
           width, a rule and a title above it; cells a pod has nothing for are
           still there, so every row has the same columns. -->
      <div
        class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-5 hover:bg-edge/30 @wide:items-stretch @wide:gap-0 @wide:py-0 @wide:pl-2.5"
        oncontextmenu={(e) => showMenu(e, menuItems(p))}
        role="listitem"
      >
        <span class="h-[7px] w-[7px] shrink-0 rounded-full @wide:mr-2 @wide:self-center {TONE[podPhaseTone(p.status)]}" use:tooltip={p.status}></span>
        <div class="min-w-0 flex-1 @wide:w-[var(--c-name)] @wide:flex-initial @wide:pr-2 {TEXT}">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-text/90">{p.name}</span>
            <span class="shrink-0 text-caption text-muted">{p.status}</span>
          </div>
        </div>
        <!-- Where the pod runs — columns only a wide container has room for
             (v1.1); in a narrow dock they stay in the details view. -->
        <span
          class="hidden truncate text-caption text-muted @wide:block @wide:w-[var(--c-ns)] @wide:px-2 {TEXT}"
          data-testid="k8s-col-namespace">{p.namespace}</span
        >
        <span
          class="hidden truncate text-caption text-muted @wide:block @wide:w-[var(--c-node)] @wide:px-2 {TEXT}"
          data-testid="k8s-col-node">{p.node}</span
        >
        <span class="hidden @wide:block @wide:flex-1" aria-hidden="true"></span>
        <!-- CPU shape over the last poll window. Unlike Docker's percentage there is
             no known ceiling for a pod (no limit is reported by `top`), so the
             series is scaled to its own peak with a floor of a tenth of a core —
             without the floor an idle pod's jitter would be drawn as a busy one.
             The wrapper is only a box in the wide layout: there it is the CPU
             column's first cell (placed before the figure with `order`), and
             stays in place when a pod has no history yet. -->
        <span
          class="contents @wide:order-1 @wide:flex @wide:w-[3.25rem] @wide:shrink-0 @wide:items-center @wide:border-l @wide:border-edge/40 @wide:pl-2"
          data-testid="k8s-col-spark"
        >
          {#if history.length > 0}
            <Sparkline
              values={padHistory(history)}
              max={historyMax(history, 100)}
              color="var(--color-accent)"
              class="h-3.5 w-10 shrink-0"
            />
          {/if}
        </span>
        <div class="flex shrink-0 items-center gap-2 text-caption text-muted tabular-nums @wide:contents">
          <span class="@wide:w-16 @wide:text-right {NUM}" use:tooltip={t("k8s.ready")}>{p.ready}</span>
          <span
            class="text-warn {p.restarts > 0 ? '' : 'hidden @wide:block'} @wide:w-12 @wide:text-right {NUM}"
            data-testid="k8s-col-restarts"
            use:tooltip={t("k8s.restarts")}>{p.restarts > 0 ? `↻${p.restarts}` : ""}</span
          >
          {#if m}
            <!-- Usage against the pod's own ceiling, from the spec we already fetch.
                 A pod with no limit gets the bare number and an explicit note — a
                 bar without a denominator would imply a ceiling nobody enforces. -->
            {@const cpu = usage(parseCpuMillis(m.cpu), p.cpuLimit)}
            {@const mem = usage(parseMemMiB(m.mem), p.memLimit)}
            {#if cpu}
              <span
                class="flex items-center gap-1 {TONE_TEXT[cpu.tone]} @wide:w-20 @wide:justify-end {CPU}"
                use:tooltip={t("k8s.limitCpu", { used: m.cpu, limit: `${p.cpuLimit}m` })}
              >
                <span class="h-1 w-6 overflow-hidden rounded bg-edge">
                  <span class="block h-full {TONE_BAR[cpu.tone]}" style="width: {cpu.pct}%"></span>
                </span>
                {Math.round(cpu.ratio * 100)}%
              </span>
            {:else}
              <span class="@wide:w-20 @wide:text-right {CPU}" use:tooltip={t("k8s.cpu")}>{m.cpu}</span>
            {/if}
            {#if mem}
              <span
                class="flex items-center gap-1 {TONE_TEXT[mem.tone]} @wide:w-20 @wide:justify-end {NUM} {LATE}"
                use:tooltip={t("k8s.limitMem", { used: m.mem, limit: `${p.memLimit}Mi` })}
              >
                <span class="h-1 w-6 overflow-hidden rounded bg-edge">
                  <span class="block h-full {TONE_BAR[mem.tone]}" style="width: {mem.pct}%"></span>
                </span>
                {Math.round(mem.ratio * 100)}%
              </span>
            {:else}
              <span class="@wide:w-20 @wide:text-right {NUM} {LATE}" use:tooltip={t("k8s.mem")}>{m.mem}</span>
            {/if}
          {:else}
            <!-- No metrics-server: a narrow row simply has no figures; a table row
                 keeps its two columns and says there is nothing to show. -->
            <span class="hidden @wide:block @wide:w-20 @wide:text-right {CPU}" data-testid="k8s-col-nometrics">—</span>
            <span class="hidden @wide:block @wide:w-20 @wide:text-right {NUM} {LATE}">—</span>
          {/if}
          <!-- The note that the figures have no ceiling. It comes from the spec, not
               from `top`, so the table shows it with or without metrics; the narrow
               row keeps it next to the figures it explains. -->
          {#if p.cpuLimit == null && p.memLimit == null}
            <span
              class="text-warn {m ? '' : 'hidden @wide:block'} @wide:w-28 @wide:truncate {NUM} {LATE}"
              data-testid="k8s-col-limits"
              use:tooltip={t("k8s.qos")}>{t("k8s.noLimit")}</span
            >
          {:else}
            <span class="hidden @wide:block @wide:w-28 {NUM} {LATE}" data-testid="k8s-col-limits"></span>
          {/if}
          <span class="@wide:w-18 @wide:text-right {NUM} {LATE}" use:tooltip={t("k8s.age")}>{p.age}</span>
        </div>
        <div
          class="flex shrink-0 items-center gap-0.5 text-muted opacity-0 group-hover:opacity-100 @wide:order-2 @wide:w-14 @wide:justify-end @wide:border-l @wide:border-edge/40"
        >
          <button
            class="rounded p-1 hover:bg-edge hover:text-text"
            use:tooltip={t("k8s.openShell")}
            aria-label={t("k8s.openShell")}
            onclick={() => openShell(p, p.containers.length > 1 ? p.containers[0] : null)}
          >
            <Icon name="terminal" size={14} />
          </button>
          <button
            class="rounded p-1 hover:bg-edge hover:text-text"
            use:tooltip={t("k8s.viewDetails")}
            aria-label={t("k8s.viewDetails")}
            onclick={() => onViewDetails(p)}
          >
            <Icon name="eye" size={14} />
          </button>
        </div>
      </div>
    {/each}
  {/each}
</div>
