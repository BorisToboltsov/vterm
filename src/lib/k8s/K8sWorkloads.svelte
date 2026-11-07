<script lang="ts">
  // Workload list for the k8s panel (Phase 37): Deployments, StatefulSets,
  // DaemonSets and CronJobs, grouped by kind. Scalable kinds (Deployment /
  // StatefulSet) get inline scale ± ; Deployment/StatefulSet/DaemonSet get rollout
  // restart; CronJobs show their schedule + suspended flag. Describe/YAML/delete
  // live in the right-click menu. Presentational + action wiring; arg building is
  // pure (k8s.ts), the orchestrator's `run` executes.
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import {
    scaleArgs,
    rolloutRestartArgs,
    deleteArgs,
    type K8sWorkload,
  } from "./k8s";
  import type { IconName } from "../ui/icons";
  import type { MenuItem } from "../ui/ctxmenu";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import type { ListGroup } from "../ui/listview";
  import { t } from "../i18n";

  let {
    groups,
    grouped = true,
    grouping = "kind",
    collapsed = [],
    ontoggle = () => {},
    busy = false,
    run,
    onDescribe,
    onYaml,
    showMenu,
    onOpen,
    selectedKey = null,
    allNamespaces = false,
  }: {
    /** The list as `listview.ts` lays it out (by kind, as it always was, by default). */
    groups: ListGroup<K8sWorkload>[];
    grouped?: boolean;
    /** What the groups are — a kind gets its icon. */
    grouping?: string;
    collapsed?: readonly string[];
    ontoggle?: (key: string) => void;
    busy?: boolean;
    run: (bareArgs: string[], namespace: string, opts?: { successKey?: string }) => Promise<boolean>;
    onDescribe: (kind: string, name: string, namespace: string) => void;
    onYaml: (kind: string, name: string, namespace: string) => void;
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
    /** Open its details (stage 4): beside the list in a wide panel, a dialog in a narrow one. */
    onOpen: (w: K8sWorkload) => void;
    /** `kind/namespace/name` of the workload whose details are open. */
    selectedKey?: string | null;
    /** The list spans namespaces: one application in two is two groups, named with theirs. */
    allNamespaces?: boolean;
  } = $props();

  const keyOf = (w: K8sWorkload) => `${w.kind}/${w.namespace}/${w.name}`;
  const JOB_TONE: Record<string, string> = { Complete: "text-ok", Failed: "text-bad", Running: "text-warn", Pending: "text-warn", Suspended: "text-muted" };

  const KIND_ICON: Record<string, IconName> = {
    Deployment: "rocket",
    StatefulSet: "database",
    DaemonSet: "container",
    CronJob: "refresh",
    Job: "play",
  };

  /** DaemonSets can't scale but can rollout restart; CronJobs do neither. */
  function canRollout(w: K8sWorkload): boolean {
    return w.kind === "Deployment" || w.kind === "StatefulSet" || w.kind === "DaemonSet";
  }

  function copyName(w: K8sWorkload) {
    void navigator.clipboard?.writeText(w.name);
  }

  function menuItems(w: K8sWorkload): MenuItem[] {
    const kind = w.kind.toLowerCase();
    const items: MenuItem[] = [
      { icon: "eye", label: t("k8s.viewDetails"), onSelect: () => onOpen(w) },
      { icon: "note", label: t("k8s.describe"), onSelect: () => onDescribe(kind, w.name, w.namespace) },
      { icon: "braces", label: t("k8s.yaml"), onSelect: () => onYaml(kind, w.name, w.namespace) },
    ];
    if (canRollout(w)) {
      items.push({
        icon: "refresh",
        label: t("k8s.rolloutRestart"),
        onSelect: () => run(rolloutRestartArgs(w.kind, w.name), w.namespace, { successKey: "k8s.restarted" }),
      });
    }
    items.push(
      { kind: "separator" },
      { icon: "copy", label: t("k8s.copyName"), onSelect: () => copyName(w) },
      { icon: "trash", label: t("k8s.delete"), danger: true, onSelect: () => run(deleteArgs(w.kind, w.name), w.namespace, { successKey: "k8s.deleted" }) },
    );
    return items;
  }

  function scale(w: K8sWorkload, delta: number) {
    if (w.replicas === null) return;
    const next = Math.max(0, w.replicas + delta);
    void run(scaleArgs(w.kind, w.name, next), w.namespace, { successKey: "k8s.scaled" });
  }
</script>

<div class="h-full overflow-auto text-xs">
  {#each groups as g (g.key)}
    {@const folded = grouped && collapsed.includes(g.key)}
    {#if grouped}
      {@const app = grouping === "app" && !g.rest ? g.items[0].app : undefined}
      <GroupHeader
        label={g.rest && grouping === "app" ? t("k8s.noApp") : app && allNamespaces ? `${g.label} · ${g.items[0].namespace}` : g.label}
        count={g.items.length}
        collapsed={folded}
        ontoggle={() => ontoggle(g.key)}
        icon={grouping === "kind" ? (KIND_ICON[g.key] ?? "cloud") : app ? (app.helm ? "ship" : "layoutGrid") : undefined}
        testid="k8s-workload-group"
      />
    {/if}

    {#each folded ? [] : g.items as w (keyOf(w))}
      <!-- A click opens the details; the keyboard has the row's own button for it
           (the eye) — the row is a list item, not a second button around them. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <div
        class="group flex cursor-default items-center gap-2 border-b border-edge/60 py-1.5 pr-2 {grouped ? 'pl-5' : 'pl-2.5'} {selectedKey === keyOf(w) ? 'bg-accent/10' : 'hover:bg-edge/30'}"
        oncontextmenu={(e) => showMenu(e, menuItems(w))}
        onclick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) onOpen(w);
        }}
        role="listitem"
        aria-current={selectedKey === keyOf(w) ? "true" : undefined}
        data-testid="k8s-workload-row"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-text/90">{w.name}</span>
            <span class="shrink-0 text-caption text-muted">{w.namespace}</span>
          </div>
          {#if w.kind === "CronJob"}
            <div class="mt-0.5 flex items-center gap-1.5 text-caption text-muted">
              <span class="font-mono">{w.schedule}</span>
              {#if w.suspended}<span class="text-warn">· {t("k8s.suspended")}</span>{/if}
            </div>
          {/if}
        </div>

        {#if w.kind === "Job"}
          <span class="shrink-0 text-meta {JOB_TONE[w.status ?? ''] ?? 'text-muted'}">{w.status}</span>
        {/if}
        {#if w.kind !== "CronJob"}
          <span class="shrink-0 text-meta text-muted tabular-nums" use:tooltip={t(w.kind === "Job" ? "k8s.completions" : "k8s.ready")}>{w.ready}</span>
        {/if}
        <span class="shrink-0 text-caption text-muted tabular-nums" use:tooltip={t("k8s.age")}>{w.age}</span>

        <div class="flex shrink-0 items-center gap-0.5 text-muted opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <button
            class="rounded p-1 hover:bg-edge hover:text-text"
            use:tooltip={t("k8s.viewDetails")}
            aria-label={t("k8s.viewDetails")}
            onclick={() => onOpen(w)}
            data-testid="k8s-workload-open"
          >
            <Icon name="eye" size={13} />
          </button>
          {#if w.scalable}
            <button
              class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40"
              disabled={busy || w.replicas === 0}
              use:tooltip={t("k8s.scaleDown")}
              aria-label={t("k8s.scaleDown")}
              onclick={() => scale(w, -1)}
            >
              <Icon name="minus" size={14} />
            </button>
            <button
              class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40"
              disabled={busy}
              use:tooltip={t("k8s.scaleUp")}
              aria-label={t("k8s.scaleUp")}
              onclick={() => scale(w, 1)}
            >
              <Icon name="plus" size={14} />
            </button>
          {/if}
          {#if canRollout(w)}
            <button
              class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40"
              disabled={busy}
              use:tooltip={t("k8s.rolloutRestart")}
              aria-label={t("k8s.rolloutRestart")}
              onclick={() => run(rolloutRestartArgs(w.kind, w.name), w.namespace, { successKey: "k8s.restarted" })}
            >
              <Icon name="refresh" size={13} />
            </button>
          {/if}
        </div>
      </div>
    {/each}
  {/each}
</div>
