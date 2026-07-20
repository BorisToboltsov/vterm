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

<div class="h-full overflow-auto text-xs">
  {#each groups as g (`${g.kind}/${g.name}`)}
    <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
      {#if g.name}
        <Icon name={KIND_ICON[g.kind] ?? "cloud"} size={13} class="text-accent" />
        <span class="min-w-0 flex-1 truncate font-medium text-white/85">{g.name}</span>
        <span class="shrink-0 text-caption uppercase tracking-wider text-muted">{g.kind}</span>
      {:else}
        <span class="text-caption uppercase tracking-wider text-muted">{t("k8s.standalone")}</span>
      {/if}
    </div>

    {#each g.pods as p (`${p.namespace}/${p.name}`)}
      {@const m = metrics(p)}
      {@const history = cpuHistory[metricsKey(p.namespace, p.name)] ?? []}
      <div
        class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-5 hover:bg-edge/30"
        oncontextmenu={(e) => showMenu(e, menuItems(p))}
        role="listitem"
      >
        <span class="h-[7px] w-[7px] shrink-0 rounded-full {TONE[podPhaseTone(p.status)]}" use:tooltip={p.status}></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-white/90">{p.name}</span>
            <span class="shrink-0 text-caption text-muted">{p.status}</span>
          </div>
        </div>
        <!-- CPU shape over the last poll window. Unlike Docker's percentage there is
             no known ceiling for a pod (no limit is reported by `top`), so the
             series is scaled to its own peak with a floor of a tenth of a core —
             without the floor an idle pod's jitter would be drawn as a busy one. -->
        {#if history.length > 0}
          <Sparkline
            values={padHistory(history)}
            max={historyMax(history, 100)}
            color="var(--color-accent)"
            class="h-3.5 w-10 shrink-0"
          />
        {/if}
        <div class="flex shrink-0 items-center gap-2 text-caption text-muted tabular-nums">
          <span use:tooltip={t("k8s.ready")}>{p.ready}</span>
          {#if p.restarts > 0}
            <span class="text-warn" use:tooltip={t("k8s.restarts")}>↻{p.restarts}</span>
          {/if}
          {#if m}
            <!-- Usage against the pod's own ceiling, from the spec we already fetch.
                 A pod with no limit gets the bare number and an explicit note — a
                 bar without a denominator would imply a ceiling nobody enforces. -->
            {@const cpu = usage(parseCpuMillis(m.cpu), p.cpuLimit)}
            {@const mem = usage(parseMemMiB(m.mem), p.memLimit)}
            {#if cpu}
              <span
                class="flex items-center gap-1 {TONE_TEXT[cpu.tone]}"
                use:tooltip={t("k8s.limitCpu", { used: m.cpu, limit: `${p.cpuLimit}m` })}
              >
                <span class="h-1 w-6 overflow-hidden rounded bg-edge">
                  <span class="block h-full {TONE_BAR[cpu.tone]}" style="width: {cpu.pct}%"></span>
                </span>
                {Math.round(cpu.ratio * 100)}%
              </span>
            {:else}
              <span use:tooltip={t("k8s.cpu")}>{m.cpu}</span>
            {/if}
            {#if mem}
              <span
                class="flex items-center gap-1 {TONE_TEXT[mem.tone]}"
                use:tooltip={t("k8s.limitMem", { used: m.mem, limit: `${p.memLimit}Mi` })}
              >
                <span class="h-1 w-6 overflow-hidden rounded bg-edge">
                  <span class="block h-full {TONE_BAR[mem.tone]}" style="width: {mem.pct}%"></span>
                </span>
                {Math.round(mem.ratio * 100)}%
              </span>
            {:else}
              <span use:tooltip={t("k8s.mem")}>{m.mem}</span>
            {/if}
            {#if p.cpuLimit == null && p.memLimit == null}
              <span class="text-warn" use:tooltip={t("k8s.qos")}>{t("k8s.noLimit")}</span>
            {/if}
          {/if}
          <span use:tooltip={t("k8s.age")}>{p.age}</span>
        </div>
        <div class="flex shrink-0 items-center gap-0.5 text-muted opacity-0 group-hover:opacity-100">
          <button
            class="rounded p-1 hover:bg-edge hover:text-white"
            use:tooltip={t("k8s.openShell")}
            aria-label={t("k8s.openShell")}
            onclick={() => openShell(p, p.containers.length > 1 ? p.containers[0] : null)}
          >
            <Icon name="terminal" size={14} />
          </button>
          <button
            class="rounded p-1 hover:bg-edge hover:text-white"
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
