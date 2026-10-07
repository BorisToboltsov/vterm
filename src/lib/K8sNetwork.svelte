<script lang="ts">
  // Network view for the k8s panel (Phase 37.1): Services + Ingress in one tab
  // (two sections, like DockerNetworks). Services expose a **port-forward** action
  // (runs `kubectl port-forward` in a real terminal, not `kubectl_run`). Describe/
  // YAML/delete live in the right-click menu. Presentational + action wiring; arg
  // building is pure (k8s.ts), the orchestrator's `run` executes.
  //
  // Since v1.5 the same data has a second view, switched in the strip on top: the
  // route (K8sRouteView) — ingress rule → service → endpoints. Both views share the
  // menus and the port-forward action below.
  import Icon from "./Icon.svelte";
  import EmptyState from "./EmptyState.svelte";
  import InfoHint from "./InfoHint.svelte";
  import ViewModeToggle from "./ViewModeToggle.svelte";
  import K8sRouteView from "./K8sRouteView.svelte";
  import { tooltip } from "./actions/tooltip";
  import { deleteArgs, type K8sService, type K8sIngress } from "./k8s";
  import type { RouteTable } from "./k8sroute";
  import type { MenuItem } from "./ctxmenu";
  import { t } from "./i18n";

  let {
    services,
    ingresses,
    view = "list",
    onView,
    routes = null,
    servicesError = null,
    ingressError = null,
    slicesError = null,
    busy = false,
    run,
    onDescribe,
    onYaml,
    onPortForward,
    showMenu,
  }: {
    services: K8sService[];
    ingresses: K8sIngress[];
    /** Which of the two views is on screen. */
    view?: "list" | "route";
    onView?: (view: "list" | "route") => void;
    /** The route table — built by the panel only while the route view is on. */
    routes?: RouteTable | null;
    /** Why a list could not be read (kubectl's own line, "" if it gave none); null when it was. */
    servicesError?: string | null;
    ingressError?: string | null;
    slicesError?: string | null;
    busy?: boolean;
    run: (bareArgs: string[], namespace: string, opts?: { successKey?: string }) => Promise<boolean>;
    onDescribe: (kind: string, name: string, namespace: string) => void;
    onYaml: (kind: string, name: string, namespace: string) => void;
    onPortForward: (target: string, namespace: string, port: number) => void;
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  function copy(text: string) {
    void navigator.clipboard?.writeText(text);
  }

  function svcMenu(s: K8sService): MenuItem[] {
    const items: MenuItem[] = [
      { icon: "note", label: t("k8s.describe"), onSelect: () => onDescribe("service", s.name, s.namespace) },
      { icon: "braces", label: t("k8s.yaml"), onSelect: () => onYaml("service", s.name, s.namespace) },
    ];
    if (s.firstPort !== null) {
      items.push({
        icon: "network",
        label: t("k8s.portForward"),
        onSelect: () => onPortForward(`svc/${s.name}`, s.namespace, s.firstPort!),
      });
    }
    items.push(
      { kind: "separator" },
      { icon: "copy", label: t("k8s.copyName"), onSelect: () => copy(s.name) },
      { icon: "trash", label: t("k8s.delete"), danger: true, onSelect: () => run(deleteArgs("service", s.name), s.namespace, { successKey: "k8s.deleted" }) },
    );
    return items;
  }

  // Takes the name and namespace, not the object: a route entry knows its ingress
  // only by those.
  function ingMenu(name: string, namespace: string): MenuItem[] {
    return [
      { icon: "note", label: t("k8s.describe"), onSelect: () => onDescribe("ingress", name, namespace) },
      { icon: "braces", label: t("k8s.yaml"), onSelect: () => onYaml("ingress", name, namespace) },
      { kind: "separator" },
      { icon: "copy", label: t("k8s.copyName"), onSelect: () => copy(name) },
      { icon: "trash", label: t("k8s.delete"), danger: true, onSelect: () => run(deleteArgs("ingress", name), namespace, { successKey: "k8s.deleted" }) },
    ];
  }
</script>

<div class="flex h-full min-h-0 flex-col text-xs">
  <!-- View switch. In the route view the strip also says what the columns are —
       and, behind the hint, how far each of them can be trusted. -->
  <div class="flex shrink-0 items-center gap-1.5 border-b border-edge px-2.5 py-1">
    {#if view === "route"}
      <span class="min-w-0 truncate text-caption text-muted">{t("k8s.routeCaption")}</span>
      <InfoHint text={t("k8s.routeHint")} />
    {/if}
    <div class="ml-auto shrink-0">
      <ViewModeToggle
        structured={view === "route"}
        onSelect={(route) => onView?.(route ? "route" : "list")}
        label={t("k8s.viewMode")}
        off={{ icon: "table", label: t("k8s.viewList"), tooltip: t("k8s.viewListTip") }}
        on={{ icon: "gateway", label: t("k8s.viewRoute"), tooltip: t("k8s.viewRouteTip") }}
        testid="k8s-net-view"
      />
    </div>
  </div>

  {#if servicesError !== null}
    <!-- Not "No services": the list was not read, which says nothing about it. -->
    <div class="min-h-0 flex-1" data-testid="k8s-net-error">
      <EmptyState icon="network" title={t("k8s.servicesFailed")} hint={servicesError || undefined} />
    </div>
  {:else if services.length === 0 && ingresses.length === 0}
    <div class="min-h-0 flex-1">
      <EmptyState icon="network" title={t("k8s.noServices")} hint={t("k8s.noServicesHint")} />
    </div>
  {:else if view === "route" && routes}
    <div class="min-h-0 flex-1">
      <K8sRouteView
        table={routes}
        {slicesError}
        {ingressError}
        onServiceMenu={(e, s) => showMenu(e, svcMenu(s))}
        onIngressMenu={(e, name, namespace) => showMenu(e, ingMenu(name, namespace))}
        {onPortForward}
      />
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-auto">
      <!-- Services -->
      <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
        <Icon name="network" size={13} class="text-accent" />
        <span class="font-medium text-text/85">{t("k8s.services")}</span>
        <span class="text-caption text-muted">{services.length}</span>
      </div>
      {#if services.length === 0}
        <div class="px-2.5 py-2 text-meta text-muted">{t("k8s.noServices")}</div>
      {:else}
        {#each services as s (`${s.namespace}/${s.name}`)}
          <div
            class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5 hover:bg-edge/30"
            oncontextmenu={(e) => showMenu(e, svcMenu(s))}
            role="listitem"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-1.5">
                <span class="truncate font-medium text-text/90">{s.name}</span>
                <span class="shrink-0 text-caption text-muted">{s.type}</span>
                <span class="shrink-0 text-caption text-muted">{s.namespace}</span>
              </div>
              <div class="truncate text-caption text-muted">
                {s.clusterIp}{#if s.externalIp && s.externalIp !== "-"} · {s.externalIp}{/if}{#if s.ports} · {s.ports}{/if}
              </div>
            </div>
            <span class="shrink-0 text-caption text-muted tabular-nums" use:tooltip={t("k8s.age")}>{s.age}</span>
            {#if s.firstPort !== null}
              <button
                class="shrink-0 rounded p-1 text-muted opacity-0 hover:bg-edge hover:text-text group-hover:opacity-100"
                use:tooltip={t("k8s.portForward")}
                aria-label={t("k8s.portForward")}
                onclick={() => onPortForward(`svc/${s.name}`, s.namespace, s.firstPort!)}
              >
                <Icon name="network" size={14} />
              </button>
            {/if}
          </div>
        {/each}
      {/if}

      <!-- Ingress -->
      <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
        <Icon name="gateway" size={13} class="text-accent" />
        <span class="font-medium text-text/85">{t("k8s.ingress")}</span>
        <span class="text-caption text-muted">{ingresses.length}</span>
      </div>
      {#if ingresses.length === 0}
        <div class="px-2.5 py-2 text-meta text-muted">{t("k8s.noIngress")}</div>
      {:else}
        {#each ingresses as i (`${i.namespace}/${i.name}`)}
          <div
            class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 pl-2.5 hover:bg-edge/30"
            oncontextmenu={(e) => showMenu(e, ingMenu(i.name, i.namespace))}
            role="listitem"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-1.5">
                <span class="truncate font-medium text-text/90">{i.name}</span>
                {#if i.className}<span class="shrink-0 text-caption text-muted">{i.className}</span>{/if}
                <span class="shrink-0 text-caption text-muted">{i.namespace}</span>
              </div>
              <div class="truncate text-caption text-muted">
                {i.hosts}{#if i.address} · {i.address}{/if}
              </div>
            </div>
            <span class="shrink-0 text-caption text-muted tabular-nums" use:tooltip={t("k8s.age")}>{i.age}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
