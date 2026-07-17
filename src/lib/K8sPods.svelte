<script lang="ts">
  // Pod list for the k8s panel (Phase 37), grouped by owning workload (Deployment /
  // StatefulSet / DaemonSet / Job, ReplicaSets rolled up to Deployments) — the
  // analogue of DockerContainers' compose grouping. Each row shows status, ready,
  // restarts, live CPU/mem (when metrics-server is present) and age; a right-click
  // menu + hover buttons drive actions. Presentational + action wiring only; arg
  // building is pure (k8s.ts), the orchestrator's `run` executes.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { deleteArgs, metricsKey, podPhaseTone, type PodGroup, type K8sPod, type K8sPodMetrics } from "./k8s";
  import type { IconName } from "./icons";
  import type { MenuItem } from "./ctxmenu";
  import { t } from "./i18n";

  let {
    groups,
    metricsByKey,
    busy = false,
    run,
    openShell,
    onViewDetails,
    showMenu,
  }: {
    groups: PodGroup[];
    /** Live `kubectl top pods` snapshot keyed by {@link metricsKey}. */
    metricsByKey: Map<string, K8sPodMetrics>;
    busy?: boolean;
    run: (bareArgs: string[], namespace: string, opts?: { successKey?: string }) => Promise<boolean>;
    openShell: (pod: K8sPod, container: string | null) => void;
    onViewDetails: (pod: K8sPod) => void;
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  const TONE: Record<string, string> = {
    ok: "bg-green-400",
    warn: "bg-amber-400",
    bad: "bg-red-500",
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
        <span class="shrink-0 text-[10px] uppercase tracking-wider text-muted">{g.kind}</span>
      {:else}
        <span class="text-[10px] uppercase tracking-wider text-muted">{t("k8s.standalone")}</span>
      {/if}
    </div>

    {#each g.pods as p (`${p.namespace}/${p.name}`)}
      {@const m = metrics(p)}
      <div
        class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-5 hover:bg-edge/30"
        oncontextmenu={(e) => showMenu(e, menuItems(p))}
        role="listitem"
      >
        <span class="h-[7px] w-[7px] shrink-0 rounded-full {TONE[podPhaseTone(p.status)]}" use:tooltip={p.status}></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-white/90">{p.name}</span>
            <span class="shrink-0 text-[10px] text-muted">{p.status}</span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2 text-[10px] text-muted tabular-nums">
          <span use:tooltip={t("k8s.ready")}>{p.ready}</span>
          {#if p.restarts > 0}
            <span class="text-amber-400" use:tooltip={t("k8s.restarts")}>↻{p.restarts}</span>
          {/if}
          {#if m}
            <span use:tooltip={t("k8s.cpu")}>{m.cpu}</span>
            <span use:tooltip={t("k8s.mem")}>{m.mem}</span>
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
