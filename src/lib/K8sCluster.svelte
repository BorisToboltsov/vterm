<script lang="ts">
  // Cluster view for the k8s panel (Phase 37.1): Nodes + recent Events in one tab.
  // Nodes support cordon/uncordon and drain (node commands are cluster-scoped — the
  // panel runs them with an empty namespace so no `--namespace` is added). Events
  // are read-only with a Warning/Normal filter for diagnostics. Presentational +
  // action wiring; arg building is pure (k8s.ts), the orchestrator's `run` executes.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    cordonArgs,
    uncordonArgs,
    drainArgs,
    nodeStatusTone,
    eventTone,
    type K8sNode,
    type K8sEvent,
  } from "./k8s";
  import type { MenuItem } from "./ctxmenu";
  import { t, type MessageKey } from "./i18n";

  let {
    nodes,
    events,
    busy = false,
    run,
    onDescribe,
    onYaml,
    showMenu,
  }: {
    nodes: K8sNode[];
    events: K8sEvent[];
    busy?: boolean;
    run: (bareArgs: string[], namespace: string, opts?: { successKey?: string }) => Promise<boolean>;
    onDescribe: (kind: string, name: string, namespace: string) => void;
    onYaml: (kind: string, name: string, namespace: string) => void;
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  const TONE: Record<string, string> = {
    ok: "bg-green-400",
    warn: "bg-amber-400",
    bad: "bg-red-500",
    idle: "bg-muted",
  };

  type Filter = "all" | "Warning" | "Normal";
  let filter = $state<Filter>("all");
  const FILTERS: { id: Filter; label: MessageKey }[] = [
    { id: "all", label: "k8s.eventsAll" },
    { id: "Warning", label: "k8s.eventsWarning" },
    { id: "Normal", label: "k8s.eventsNormal" },
  ];
  const shownEvents = $derived(
    (filter === "all" ? events : events.filter((e) => e.type === filter)).slice(0, 100),
  );

  function copy(text: string) {
    void navigator.clipboard?.writeText(text);
  }

  function nodeMenu(n: K8sNode): MenuItem[] {
    return [
      { icon: "note", label: t("k8s.describe"), onSelect: () => onDescribe("node", n.name, "") },
      { icon: "braces", label: t("k8s.yaml"), onSelect: () => onYaml("node", n.name, "") },
      n.schedulable
        ? { icon: "pause", label: t("k8s.cordon"), onSelect: () => run(cordonArgs(n.name), "", { successKey: "k8s.cordoned" }) }
        : { icon: "play", label: t("k8s.uncordon"), onSelect: () => run(uncordonArgs(n.name), "", { successKey: "k8s.uncordoned" }) },
      { icon: "swap", label: t("k8s.drain"), danger: true, onSelect: () => run(drainArgs(n.name), "", { successKey: "k8s.drained" }) },
      { kind: "separator" },
      { icon: "copy", label: t("k8s.copyName"), onSelect: () => copy(n.name) },
    ];
  }
</script>

<div class="h-full overflow-auto text-xs">
  <!-- Nodes -->
  <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
    <Icon name="server" size={13} class="text-accent" />
    <span class="font-medium text-white/85">{t("k8s.nodes")}</span>
    <span class="text-[10px] text-muted">{nodes.length}</span>
  </div>
  {#if nodes.length === 0}
    <div class="px-2.5 py-2 text-[11px] text-muted">{t("k8s.noNodes")}</div>
  {:else}
    {#each nodes as n (n.name)}
      <div
        class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5 hover:bg-edge/30"
        oncontextmenu={(e) => showMenu(e, nodeMenu(n))}
        role="listitem"
      >
        <span class="h-[7px] w-[7px] shrink-0 rounded-full {TONE[nodeStatusTone(n.status)]}" use:tooltip={n.status}></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-white/90">{n.name}</span>
            <span class="shrink-0 text-[10px] text-muted">{n.roles}</span>
          </div>
          <div class="truncate text-[10px] text-muted">{n.version}{#if n.internalIp} · {n.internalIp}{/if}</div>
        </div>
        <span class="shrink-0 text-[10px] text-muted tabular-nums" use:tooltip={t("k8s.age")}>{n.age}</span>
        <div class="flex shrink-0 items-center gap-0.5 text-muted opacity-0 group-hover:opacity-100">
          {#if n.schedulable}
            <button class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("k8s.cordon")} aria-label={t("k8s.cordon")} onclick={() => run(cordonArgs(n.name), "", { successKey: "k8s.cordoned" })}>
              <Icon name="pause" size={14} />
            </button>
          {:else}
            <button class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("k8s.uncordon")} aria-label={t("k8s.uncordon")} onclick={() => run(uncordonArgs(n.name), "", { successKey: "k8s.uncordoned" })}>
              <Icon name="play" size={14} />
            </button>
          {/if}
          <button class="rounded p-1 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} use:tooltip={t("k8s.drain")} aria-label={t("k8s.drain")} onclick={() => run(drainArgs(n.name), "", { successKey: "k8s.drained" })}>
            <Icon name="swap" size={14} />
          </button>
        </div>
      </div>
    {/each}
  {/if}

  <!-- Events -->
  <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
    <Icon name="activity" size={13} class="text-accent" />
    <span class="flex-1 font-medium text-white/85">{t("k8s.events")}</span>
    <div class="flex items-center gap-0.5">
      {#each FILTERS as f (f.id)}
        <button
          data-testid={`k8s-event-filter-${f.id}`}
          class="rounded border px-1.5 py-0.5 text-[10px] {filter === f.id ? 'border-accent text-accent' : 'border-edge text-muted hover:text-white'}"
          aria-pressed={filter === f.id}
          onclick={() => (filter = f.id)}
        >
          {t(f.label)}
        </button>
      {/each}
    </div>
  </div>
  {#if shownEvents.length === 0}
    <div class="px-2.5 py-2 text-[11px] text-muted">{t("k8s.noEvents")}</div>
  {:else}
    {#each shownEvents as e, idx (idx)}
      <div class="flex items-start gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5">
        <span class="mt-1 h-[7px] w-[7px] shrink-0 rounded-full {TONE[eventTone(e.type)]}" use:tooltip={e.type}></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="shrink-0 font-medium text-white/90">{e.reason}</span>
            <span class="truncate text-[10px] text-muted">{e.object}</span>
          </div>
          <div class="truncate text-[10px] text-muted" use:tooltip={e.message}>{e.message}</div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5 text-[10px] text-muted tabular-nums">
          {#if e.count > 1}<span use:tooltip={t("k8s.count")}>×{e.count}</span>{/if}
          <span use:tooltip={t("k8s.age")}>{e.age}</span>
        </div>
      </div>
    {/each}
  {/if}
</div>
