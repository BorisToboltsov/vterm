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
  } = $props();

  const KIND_ICON: Record<string, IconName> = {
    Deployment: "rocket",
    StatefulSet: "database",
    DaemonSet: "container",
    CronJob: "refresh",
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
      <GroupHeader
        label={g.label}
        count={g.items.length}
        collapsed={folded}
        ontoggle={() => ontoggle(g.key)}
        icon={grouping === "kind" ? (KIND_ICON[g.key] ?? "cloud") : undefined}
        testid="k8s-workload-group"
      />
    {/if}

    {#each folded ? [] : g.items as w (`${w.namespace}/${w.name}`)}
      <div
        class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 hover:bg-edge/30 {grouped ? 'pl-5' : 'pl-2.5'}"
        oncontextmenu={(e) => showMenu(e, menuItems(w))}
        role="listitem"
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

        {#if w.kind !== "CronJob"}
          <span class="shrink-0 text-meta text-muted tabular-nums" use:tooltip={t("k8s.ready")}>{w.ready}</span>
        {/if}
        <span class="shrink-0 text-caption text-muted tabular-nums" use:tooltip={t("k8s.age")}>{w.age}</span>

        <div class="flex shrink-0 items-center gap-0.5 text-muted opacity-0 group-hover:opacity-100">
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
