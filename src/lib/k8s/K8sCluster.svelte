<script lang="ts">
  // Cluster view for the k8s panel (Phase 37.1): Nodes + recent Events in one tab.
  // Nodes support cordon/uncordon and drain (node commands are cluster-scoped — the
  // panel runs them with an empty namespace so no `--namespace` is added). Events
  // are read-only with a Warning/Normal filter for diagnostics. Presentational +
  // action wiring; arg building is pure (k8s.ts), the orchestrator's `run` executes.
  import Icon from "../ui/Icon.svelte";
  import FilteredEmpty from "../ui/FilteredEmpty.svelte";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import ListHeader from "../ui/ListHeader.svelte";
  import { tooltip } from "../actions/tooltip";
  import { listMenuText, type ListLabels } from "../ui/listtext";
  import { applyView, filterSummary, NO_FILTER, type ListFilter, type ListOrder } from "../ui/listview";
  import {
    cordonArgs,
    uncordonArgs,
    drainArgs,
    nodeStatusTone,
    eventTone,
    claimReasons,
    EVENT_ORDER,
    EVENT_SCHEMA,
    type K8sNode,
    type K8sEvent,
    type K8sClaim,
  } from "./k8s";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import { t } from "../i18n";

  let {
    nodes,
    events,
    busy = false,
    run,
    onDescribe,
    onYaml,
    showMenu,
    wide = false,
    eventFilter = NO_FILTER,
    oneventfilter = () => {},
    eventOrder = EVENT_ORDER,
    oneventorder = () => {},
    collapsed = [],
    ontoggle = () => {},
    onmenu = () => {},
    onOpenNode = () => {},
    selectedNode = null,
    claims = [],
    claimUsers = null,
  }: {
    nodes: K8sNode[];
    events: K8sEvent[];
    busy?: boolean;
    run: (bareArgs: string[], namespace: string, opts?: { successKey?: string }) => Promise<boolean>;
    onDescribe: (kind: string, name: string, namespace: string) => void;
    onYaml: (kind: string, name: string, namespace: string) => void;
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
    /** The panel's width threshold, for the events' filter row (v1.29). */
    wide?: boolean;
    /** What the events are narrowed to — this session's, kept by the panel. */
    eventFilter?: ListFilter;
    oneventfilter?: (next: ListFilter) => void;
    eventOrder?: ListOrder;
    oneventorder?: (next: ListOrder) => void;
    /** Folded sections: `nodes`, `events`. */
    collapsed?: readonly string[];
    ontoggle?: (key: string) => void;
    onmenu?: (menu: OpenMenu) => void;
    /** Open a node's details (stage 5). */
    onOpenNode?: (n: K8sNode) => void;
    /** The node whose details are open. */
    selectedNode?: string | null;
    /** The volume claims in scope (stage 5). */
    claims?: readonly K8sClaim[];
    /** Who mounts each claim (`namespace/claim` → pods); null — the pods were not read. */
    claimUsers?: ReadonlyMap<string, string[]> | null;
  } = $props();

  // Why a claim waits is what the cluster said last about it — the events are here already.
  const why = $derived(claimReasons(events));
  const CLAIM_TONE: Record<string, string> = { Bound: "bg-ok", Pending: "bg-warn", Lost: "bg-bad" };

  const TONE: Record<string, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    idle: "bg-muted",
  };

  // The events' filter row (v1.29): the Warning / Normal chips became the «Type»
  // facet; the list still shows the latest hundred of what is kept.
  const EVENT_LABELS: ListLabels = {
    sort: (id) => t(id === "time" ? "k8s.time" : "k8s.count"),
    facet: () => t("k8s.eventType"),
  };
  const eventView = $derived(applyView(events, EVENT_SCHEMA, eventFilter, eventOrder));
  const shownEvents = $derived(eventView.groups[0].items.slice(0, 100));
  const folded = (key: string) => collapsed.includes(key);

  function copy(text: string) {
    void navigator.clipboard?.writeText(text);
  }

  function nodeMenu(n: K8sNode): MenuItem[] {
    return [
      { icon: "eye", label: t("k8s.viewDetails"), onSelect: () => onOpenNode(n) },
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
  <GroupHeader label={t("k8s.nodes")} count={nodes.length} collapsed={folded("nodes")} ontoggle={() => ontoggle("nodes")} icon="server" testid="k8s-cluster-section" />
  {#if !folded("nodes") && nodes.length === 0}
    <div class="px-2.5 py-2 text-meta text-muted">{t("k8s.noNodes")}</div>
  {:else if !folded("nodes")}
    {#each nodes as n (n.name)}
      <!-- A click opens the details (stage 5); the keyboard has the row's eye. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <div
        class="group flex cursor-default items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5 {selectedNode === n.name ? 'bg-accent/10' : 'hover:bg-edge/30'}"
        oncontextmenu={(e) => showMenu(e, nodeMenu(n))}
        onclick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) onOpenNode(n);
        }}
        role="listitem"
        aria-current={selectedNode === n.name ? "true" : undefined}
        data-testid="k8s-node-row"
      >
        <span class="h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full {TONE[nodeStatusTone(n.status)]}" use:tooltip={n.status}></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-text/90">{n.name}</span>
            <span class="shrink-0 text-caption text-muted">{n.roles}</span>
            {#each n.pressures ?? [] as pr (pr)}<span class="shrink-0 text-caption text-bad" data-testid="k8s-node-pressure">{pr}</span>{/each}
          </div>
          <!-- Every address the node reports (v1.33): the internal one pods and
               nodes talk on, the external one it is reached at from outside. -->
          <div class="truncate text-caption text-muted" data-testid="k8s-node-addresses">
            {n.version}{#if n.internalIp}{" · "}<span class="font-mono" use:tooltip={t("k8s.internalIp")}>{n.internalIp}</span>{/if}{#if n.externalIp}{" · "}<span class="font-mono text-text/85" use:tooltip={t("k8s.externalIp")}>{n.externalIp}</span>{/if}{#if n.hostname && n.hostname !== n.name}{` · ${n.hostname}`}{/if}
          </div>
        </div>
        <span class="shrink-0 text-caption text-muted tabular-nums" use:tooltip={t("k8s.age")}>{n.age}</span>
        <div class="flex shrink-0 items-center gap-0.5 text-muted opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <button class="rounded p-1 hover:bg-edge hover:text-text" use:tooltip={t("k8s.viewDetails")} aria-label={t("k8s.viewDetails")} onclick={() => onOpenNode(n)}>
            <Icon name="eye" size={13} />
          </button>
          {#if n.schedulable}
            <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("k8s.cordon")} aria-label={t("k8s.cordon")} onclick={() => run(cordonArgs(n.name), "", { successKey: "k8s.cordoned" })}>
              <Icon name="pause" size={14} />
            </button>
          {:else}
            <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("k8s.uncordon")} aria-label={t("k8s.uncordon")} onclick={() => run(uncordonArgs(n.name), "", { successKey: "k8s.uncordoned" })}>
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
  <!-- The volume claims (stage 5): what each got, why one waits — the latest event
       about it — and who mounts it, from the pods' own volumes. -->
  <GroupHeader label={t("k8s.claimsTitle")} count={claims.length} collapsed={folded("claims")} ontoggle={() => ontoggle("claims")} icon="hardDrive" testid="k8s-cluster-section" />
  {#if !folded("claims")}
    {#if claims.length === 0}
      <div class="px-2.5 py-2 text-meta text-muted">{t("k8s.noClaims")}</div>
    {:else}
      {#each claims as c (`${c.namespace}/${c.name}`)}
        {@const key = `${c.namespace}/${c.name}`}
        {@const users = claimUsers?.get(key) ?? []}
        {@const said = why.get(key)}
        <div class="flex items-start gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5" data-testid="k8s-claim-row">
          <span class="mt-1 h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full {CLAIM_TONE[c.phase] ?? 'bg-muted'}" use:tooltip={c.phase}></span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-1.5">
              <span class="truncate font-medium text-text/90">{c.name}</span>
              <span class="shrink-0 text-caption text-muted">{c.namespace}</span>
              <span class="shrink-0 text-caption {c.phase === 'Bound' ? 'text-muted' : 'text-warn'}">{c.phase}</span>
            </div>
            <div class="truncate text-caption text-muted">
              <span class="font-mono">{c.capacity || c.requested || "—"}</span>{#if c.storageClass}{` · ${c.storageClass}`}{/if}{#if c.access}{` · ${c.access}`}{/if}
            </div>
            {#if c.phase !== "Bound" && said}
              <div class="break-words text-caption {said.type === 'Warning' ? 'text-warn' : 'text-muted'}" data-testid="k8s-claim-why">{said.message}</div>
            {/if}
            {#if claimUsers}
              <div class="truncate text-caption {users.length ? 'text-muted' : 'text-warn'}" data-testid="k8s-claim-users">
                {users.length ? t("k8s.claimUsedBy", { pods: users.join(", ") }) : t("k8s.claimUnused")}
              </div>
            {/if}
          </div>
          <span class="shrink-0 text-caption text-muted tabular-nums" use:tooltip={t("k8s.age")}>{c.age}</span>
        </div>
      {/each}
    {/if}
  {/if}

  <GroupHeader label={t("k8s.events")} count={eventView.shown} collapsed={folded("events")} ontoggle={() => ontoggle("events")} icon="activity" testid="k8s-cluster-section" />
  {#if !folded("events")}
  {#if events.length > 0}
    <ListHeader
      items={events}
      schema={EVENT_SCHEMA}
      filter={eventFilter}
      onfilter={oneventfilter}
      order={eventOrder}
      onorder={oneventorder}
      shown={eventView.shown}
      total={eventView.total}
      labels={EVENT_LABELS}
      placeholder={t("k8s.filterEvents")}
      {wide}
      {onmenu}
      testid="k8s-events-header"
    />
  {/if}
  {#if eventView.filtered && eventView.shown === 0}
    <FilteredEmpty
      summary={filterSummary(EVENT_SCHEMA, eventFilter, listMenuText(EVENT_LABELS))}
      onreset={() => oneventfilter(NO_FILTER)}
    />
  {:else if shownEvents.length === 0}
    <div class="px-2.5 py-2 text-meta text-muted">{t("k8s.noEvents")}</div>
  {:else}
    {#each shownEvents as e, idx (idx)}
      <div class="flex items-start gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5">
        <span class="mt-1 h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full {TONE[eventTone(e.type)]}" use:tooltip={e.type}></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="shrink-0 font-medium text-text/90">{e.reason}</span>
            <span class="truncate text-caption text-muted">{e.object}</span>
          </div>
          <div class="truncate text-caption text-muted" use:tooltip={e.message}>{e.message}</div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5 text-caption text-muted tabular-nums">
          {#if e.count > 1}<span use:tooltip={t("k8s.count")}>×{e.count}</span>{/if}
          <span use:tooltip={t("k8s.age")}>{e.age}</span>
        </div>
      </div>
    {/each}
  {/if}
  {/if}
</div>
