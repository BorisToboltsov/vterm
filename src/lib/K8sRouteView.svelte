<script lang="ts">
  // Route view of the k8s panel's Network sub-tab (v1.5): ingress rule → service
  // → endpoints, one row per service. A chain, so it is drawn as columns, not as
  // a graph; in a narrow dock the three cells stack in the same order.
  // Presentational: the table comes from buildRoutes (k8sroute.ts), which reads
  // endpoints from EndpointSlices and never matches a selector against pods.
  //
  // Three things are kept apart on purpose, because they look alike and mean
  // different things: "no endpoints" (the service routes nowhere), "endpoints
  // not read" (the cluster refused the question) and "not loaded yet".
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { tooltip } from "./actions/tooltip";
  import type { K8sService } from "./k8s";
  import {
    portLabel,
    routeTone,
    shownEndpoints,
    type EndpointState,
    type RouteEntry,
    type RouteTable,
    type RouteTone,
  } from "./k8sroute";
  import { t, type MessageKey } from "./i18n";

  let {
    table,
    slicesError = null,
    ingressError = null,
    onServiceMenu,
    onIngressMenu,
    onPortForward,
  }: {
    table: RouteTable;
    /** Why EndpointSlices could not be read; null while they are fine or on their way. */
    slicesError?: string | null;
    /** Why ingresses could not be read; null when they were. */
    ingressError?: string | null;
    onServiceMenu: (e: MouseEvent, service: K8sService) => void;
    onIngressMenu: (e: MouseEvent, name: string, namespace: string) => void;
    onPortForward: (target: string, namespace: string, port: number) => void;
  } = $props();

  // The three columns of a wide container; below it the cells stack.
  const COLS = "@wide:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]";
  const RULE = "@wide:border-r @wide:border-edge/40";
  const TONE: Record<RouteTone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };
  const TONE_TEXT: Record<RouteTone, string> = {
    ok: "text-muted",
    warn: "text-warn",
    bad: "text-bad",
    idle: "text-muted",
  };
  const EP_DOT: Record<EndpointState, string> = { ready: "bg-ok", terminating: "bg-warn", notReady: "bg-bad" };
  const EP_TEXT: Record<EndpointState, string> = { ready: "text-muted", terminating: "text-warn", notReady: "text-bad" };
  const EP_LABEL: Record<EndpointState, MessageKey> = {
    ready: "k8s.epReady",
    terminating: "k8s.epTerminating",
    notReady: "k8s.epNotReady",
  };

  /** What a rule matches: `host/path`, `*` standing for every host, as kubectl prints it. */
  function entryLabel(e: RouteEntry): string {
    return e.isDefault ? t("k8s.routeDefaultBackend") : `${e.host || "*"}${e.path}`;
  }

  /** The service's facts under its name: cluster IP (when it has one) and its ports. */
  function serviceFacts(s: K8sService, ports: string[]): string {
    const ip = s.clusterIp && s.clusterIp !== "None" ? [s.clusterIp] : [];
    return [...ip, ...ports].join(" · ");
  }
</script>

{#snippet entry(e: RouteEntry, problem: string | null)}
  <!-- One ingress rule. What it shows is what the manifest declares. -->
  <div
    class="flex items-start gap-1.5 py-0.5"
    oncontextmenu={(ev) => onIngressMenu(ev, e.ingress, e.namespace)}
    role="group"
    aria-label={entryLabel(e)}
    data-testid="k8s-route-entry"
  >
    <Icon name="gateway" size={13} class="mt-0.5 shrink-0 text-accent" />
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-1.5">
        <span class="truncate font-medium text-text/90" use:tooltip={e.host ? undefined : t("k8s.routeAnyHost")}>{entryLabel(e)}</span>
        {#if e.tls}
          <span class="shrink-0 self-center text-muted" use:tooltip={"TLS"}><Icon name="lock" size={11} /></span>
        {/if}
        {#if e.backend.port}
          <span class="shrink-0 font-mono text-caption text-muted">:{e.backend.port}</span>
        {/if}
      </div>
      <div class="flex min-w-0 items-baseline gap-1 text-caption text-muted">
        <span class="truncate">{e.ingress}{#if e.className} · {e.className}{/if}</span>
        <span class="shrink-0">·</span>
        {#if e.address}
          <span class="shrink-0">{e.address}</span>
        {:else}
          <!-- An empty status is all the data says; why it is empty, it does not. -->
          <span class="shrink-0" use:tooltip={t("k8s.routeNoAddressTip")}>{t("k8s.routeNoAddress")}</span>
        {/if}
      </div>
      {#if problem}
        <div class="text-caption text-bad" data-testid="k8s-route-problem">{problem}</div>
      {/if}
    </div>
  </div>
{/snippet}

<div class="h-full overflow-auto text-xs" data-testid="k8s-route">
  <!-- Column heads — only where the chain runs left to right. -->
  <div class="sticky top-0 z-10 hidden border-b border-edge bg-panel-alt text-meta font-medium text-muted @wide:grid {COLS}">
    <span class="px-2.5 py-1.5 {RULE}">{t("k8s.ingress")}</span>
    <span class="px-2.5 py-1.5 {RULE}">{t("k8s.service")}</span>
    <span class="px-2.5 py-1.5">{t("k8s.endpoints")}</span>
  </div>

  {#if ingressError !== null}
    <!-- Said once, up here: in a narrow dock the per-row cell that says it is hidden. -->
    <div class="border-b border-edge/60 px-2.5 py-1.5 text-caption text-warn" use:tooltip={ingressError || undefined} data-testid="k8s-route-ingress-error">
      {t("k8s.routeIngressFailed")}
    </div>
  {/if}

  {#each table.routes as r (r.key)}
    {@const tg = r.targets}
    <div class="grid grid-cols-1 border-b border-edge/60 hover:bg-edge/30 {COLS}" role="listitem" data-testid="k8s-route-row">
      <!-- Who points here. With nothing to show the cell is dropped in a narrow
           dock (it would be a line of "no ingress" per internal service). -->
      <div class="min-w-0 px-2.5 pt-1 @wide:py-1 {RULE} {r.entries?.length ? '' : 'hidden @wide:block'}">
        {#if r.entries === null}
          <span class="text-caption text-muted">{t("k8s.routeIngressUnknown")}</span>
        {:else if r.entries.length === 0}
          <span class="text-caption text-muted">{t("k8s.routeNoIngress")}</span>
        {:else}
          {#each r.entries as e (e.key)}
            {@render entry(e, e.portDeclared ? null : t("k8s.routePortMissing", { port: e.backend.port || "—" }))}
          {/each}
        {/if}
      </div>

      <!-- The service. -->
      <div
        class="group flex min-w-0 items-start gap-2 px-2.5 py-1.5 {RULE}"
        oncontextmenu={(e) => onServiceMenu(e, r.service)}
        role="group"
        aria-label={r.service.name}
      >
        <span class="mt-1 h-[7px] w-[7px] shrink-0 rounded-full {TONE[r.tone]}" data-testid="k8s-route-tone" data-tone={r.tone}></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-text/90">{r.service.name}</span>
            <span class="shrink-0 text-caption text-muted">{r.service.type}</span>
            {#if r.service.headless}
              <span class="shrink-0 text-caption text-muted" use:tooltip={t("k8s.routeHeadlessTip")}>headless</span>
            {/if}
            <span class="shrink-0 text-caption text-muted">{r.service.namespace}</span>
          </div>
          <div class="truncate font-mono text-caption text-muted">{serviceFacts(r.service, r.ports.map(portLabel))}</div>
        </div>
        {#if r.service.firstPort !== null}
          <button
            class="shrink-0 rounded p-1 text-muted opacity-0 hover:bg-edge hover:text-text group-hover:opacity-100"
            use:tooltip={t("k8s.portForward")}
            aria-label={t("k8s.portForward")}
            onclick={() => onPortForward(`svc/${r.service.name}`, r.service.namespace, r.service.firstPort!)}
          >
            <Icon name="network" size={14} />
          </button>
        {/if}
      </div>

      <!-- Where the cluster sends its traffic. -->
      <div class="min-w-0 pb-1.5 pl-[25px] pr-2.5 @wide:py-1.5 @wide:pl-2.5" data-testid="k8s-route-targets">
        {#if tg.kind === "externalName"}
          <span class="text-caption text-muted">{t("k8s.routeExternalName", { name: tg.name || "—" })}</span>
        {:else if tg.kind === "unknown"}
          {#if slicesError !== null}
            <span class="text-caption text-warn" use:tooltip={slicesError || undefined}>{t("k8s.routeSlicesFailed")}</span>
          {:else}
            <Skeleton width="55%" height="0.6rem" />
          {/if}
        {:else if tg.endpoints.length === 0}
          <div class="text-caption text-bad">{t("k8s.routeNoEndpoints")}</div>
          <div class="truncate text-caption text-muted">
            {r.service.selector ? t("k8s.routeSelector", { selector: r.service.selector }) : t("k8s.routeNoSelector")}
          </div>
        {:else}
          {@const list = shownEndpoints(tg.endpoints)}
          <div class="text-caption {TONE_TEXT[routeTone(tg, null)]}">
            {t("k8s.routeReadyCount", { ready: tg.ready, total: tg.endpoints.length })}
          </div>
          {#each list.shown as ep (`${ep.targetKind}/${ep.targetName}|${ep.addresses.join()}`)}
            <div class="flex items-baseline gap-1.5" data-testid="k8s-route-endpoint">
              <span class="h-[6px] w-[6px] shrink-0 self-center rounded-full {EP_DOT[ep.state]}"></span>
              <span class="shrink-0 font-mono text-caption text-text/85">{ep.addresses.join(", ")}</span>
              <span class="min-w-0 truncate text-caption text-muted" use:tooltip={ep.node || undefined}>{ep.targetName}</span>
              {#if ep.state !== "ready"}
                <span class="shrink-0 text-caption {EP_TEXT[ep.state]}">{t(EP_LABEL[ep.state])}</span>
              {/if}
            </div>
          {/each}
          {#if list.hidden > 0}
            <div class="text-caption text-muted">{t("k8s.routeMore", { n: list.hidden })}</div>
          {/if}
        {/if}
      </div>
    </div>
  {/each}

  {#if table.dangling.length > 0}
    <div class="border-b border-edge px-2.5 py-1 text-caption uppercase tracking-wider text-muted">{t("k8s.routeDangling")}</div>
    {#each table.dangling as d (d.entry.key)}
      <div class="border-b border-edge/60 px-2.5 py-1 hover:bg-edge/30" role="listitem" data-testid="k8s-route-dangling">
        {@render entry(
          d.entry,
          d.reason === "serviceMissing"
            ? t("k8s.routeServiceMissing", { name: d.entry.backend.service, namespace: d.entry.namespace })
            : null,
        )}
        {#if d.reason === "resource"}
          <div class="pl-[19px] text-caption text-muted">{t("k8s.routeResourceBackend", { resource: d.entry.backend.resource })}</div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
