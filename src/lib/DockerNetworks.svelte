<script lang="ts">
  // Networks + volumes for the Docker panel (Phase 35), in one sub-tab.
  // Presentational + action wiring; arg building is pure (docker.ts). Per-row
  // remove + per-section "prune" (both destructive → prod-confirmed by the
  // orchestrator's `run`).
  //
  // Since v1.5 the sub-tab also answers "who can reach what" (dockernet.ts): what
  // every published port is reachable from, which containers each network holds,
  // and — behind the view switch — the same membership as a graph. All of it is
  // read from the `ps` snapshot the panel already takes; nothing extra is run.
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import ViewModeToggle from "./ViewModeToggle.svelte";
  import DockerNetGraph from "./DockerNetGraph.svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    removeNetworkArgs,
    removeVolumeArgs,
    pruneNetworksArgs,
    pruneVolumesArgs,
    stateTone,
    type DockerContainer,
    type DockerNetwork,
    type DockerVolume,
  } from "./docker";
  import {
    HOST_NETWORK,
    NONE_NETWORK,
    containerPorts,
    isDefaultBridge,
    isSharedNetwork,
    membersByNetwork,
    type PortRow,
  } from "./dockernet";
  import { t } from "./i18n";

  let {
    networks,
    volumes,
    containers = [],
    view = "list",
    onView,
    busy = false,
    run,
  }: {
    networks: DockerNetwork[];
    volumes: DockerVolume[];
    /** Every container on the host, for ports and membership. */
    containers?: DockerContainer[];
    /** Which of the two views is on screen. */
    view?: "list" | "graph";
    onView?: (view: "list" | "graph") => void;
    busy?: boolean;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
  } = $props();

  const TONE: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };

  const ports = $derived(containerPorts(containers));
  const members = $derived(membersByNetwork(containers));

  /** `8080 → 80/tcp`, a declared-only `7000/tcp`, or docker's own text when unrecognized. */
  function mapping(row: PortRow): string {
    if (row.kind === "raw") return row.raw;
    const inner = `${row.containerPort}/${row.proto}`;
    return row.kind === "published" ? `${row.hostPort} → ${inner}` : inner;
  }

  /** What the port can be reached from — nothing is claimed for a token we did not parse. */
  function reach(row: PortRow): { label: string; tip: string; strong: boolean } | null {
    if (row.kind === "exposed") return { label: t("docker.portExposed"), tip: t("docker.portExposedTip"), strong: false };
    if (row.kind !== "published") return null;
    const bound = row.hostIps.join(", ");
    if (row.reach === "all") return { label: t("docker.reachAll"), tip: t("docker.reachAllTip", { addresses: bound }), strong: true };
    if (row.reach === "loopback") {
      return { label: t("docker.reachLoopback"), tip: t("docker.reachLoopbackTip", { addresses: bound }), strong: false };
    }
    return { label: t("docker.reachAddress", { addresses: bound }), tip: t("docker.reachAddressTip"), strong: false };
  }

  /** What a network's name does not say about it. */
  function networkNote(n: DockerNetwork): string | null {
    if (n.name === HOST_NETWORK) return t("docker.netHostNote");
    if (n.name === NONE_NETWORK) return t("docker.netNoneNote");
    if (isDefaultBridge(n)) return t("docker.netDefaultBridgeNote");
    return null;
  }
</script>

<div class="flex h-full min-h-0 flex-col text-xs">
  <!-- View switch. Over the graph the strip also carries its one caveat. -->
  <div class="flex shrink-0 items-center gap-1.5 border-b border-edge px-2.5 py-1">
    {#if view === "graph"}
      <span class="min-w-0 truncate text-caption text-muted">{t("docker.graphCaption")}</span>
      <InfoHint text={t("docker.graphHint")} />
    {/if}
    <div class="ml-auto shrink-0">
      <ViewModeToggle
        structured={view === "graph"}
        onSelect={(graph) => onView?.(graph ? "graph" : "list")}
        label={t("docker.viewMode")}
        off={{ icon: "table", label: t("docker.viewList"), tooltip: t("docker.viewListTip") }}
        on={{ icon: "network", label: t("docker.viewGraph"), tooltip: t("docker.viewGraphTip") }}
        testid="docker-net-view"
      />
    </div>
  </div>

  {#if view === "graph"}
    <div class="min-h-0 flex-1">
      <DockerNetGraph {networks} {containers} />
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-auto">
      <!-- Ports: what each one is reachable from -->
      <div class="border-b border-edge px-2.5 py-1 text-caption uppercase tracking-wider text-muted">{t("docker.ports")}</div>
      {#if ports.length === 0}
        <div class="border-b border-edge/60 px-2.5 py-2 text-meta text-muted" data-testid="docker-ports-empty">{t("docker.noPorts")}</div>
      {/if}
      {#each ports as p (p.container.id)}
        <div class="flex items-start gap-2 border-b border-edge/60 px-2.5 py-1.5 hover:bg-edge/30" role="listitem" data-testid="docker-ports-row">
          <span class="mt-1 h-[7px] w-[7px] shrink-0 rounded-full {TONE[stateTone(p.container.state)]}" use:tooltip={p.container.state}></span>
          <span class="w-2/5 min-w-0 shrink-0 truncate font-medium text-text/90 @wide:w-64" use:tooltip={p.container.name}>{p.container.name}</span>
          <div class="min-w-0 flex-1">
            {#each p.rows as row}
              {@const r = reach(row)}
              <div class="flex items-baseline gap-2">
                <span class="shrink-0 font-mono text-caption text-text/85">{mapping(row)}</span>
                {#if r}
                  <span class="min-w-0 truncate text-caption {r.strong ? 'text-text/85' : 'text-muted'}" use:tooltip={r.tip} data-testid="docker-port-reach">{r.label}</span>
                {/if}
              </div>
            {/each}
            {#if p.hostMode}
              <div class="text-caption text-muted">{t("docker.portHostMode")}</div>
            {/if}
            {#if p.rows.length > 0 && !p.live}
              <!-- The mapping is configuration; behind it nothing listens. -->
              <div class="text-caption text-warn">{t("docker.portInactive")}</div>
            {/if}
          </div>
        </div>
      {/each}

      <!-- Networks -->
      <div class="flex items-center justify-between border-b border-edge px-2.5 py-1 text-caption uppercase tracking-wider text-muted">
        <span>{t("docker.networks")}</span>
        <button class="flex items-center gap-1 rounded px-1 py-0.5 normal-case hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} onclick={() => run(pruneNetworksArgs(), { destructive: true, successKey: "docker.pruned" })}>
          <Icon name="trash" size={11} />{t("docker.prune")}
        </button>
      </div>
      {#each networks as n (n.id)}
        {@const inside = members.get(n.name) ?? []}
        {@const note = networkNote(n)}
        <div class="group border-b border-edge/60 px-2.5 py-1.5 hover:bg-edge/30" data-testid="docker-network-row">
          <div class="flex items-center gap-2">
            <Icon name="network" size={14} class="shrink-0 text-accent" />
            <span class="min-w-0 flex-1 truncate text-text/90">{n.name}</span>
            <span class="shrink-0 text-caption text-muted">{n.driver} · {n.scope}</span>
            <button class="shrink-0 rounded p-1 text-danger opacity-0 hover:bg-edge group-hover:opacity-100 disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={() => run(removeNetworkArgs([n.id]), { destructive: true, successKey: "docker.removed" })}>
              <Icon name="trash" size={13} />
            </button>
          </div>
          {#if note}
            <div class="pl-[22px] text-caption text-muted">{note}</div>
          {/if}
          {#if inside.length > 0}
            <div class="flex flex-wrap gap-x-3 gap-y-0.5 pl-[22px] pt-0.5">
              {#each inside as c (c.id)}
                <span class="flex min-w-0 items-center gap-1 text-caption text-text/80" data-testid="docker-network-member">
                  <span class="h-[6px] w-[6px] shrink-0 rounded-full {TONE[stateTone(c.state)]}" use:tooltip={c.state}></span>
                  <span class="truncate">{c.name}</span>
                </span>
              {/each}
            </div>
          {:else if isSharedNetwork(n.name)}
            <div class="pl-[22px] text-caption text-muted">{t("docker.netEmpty")}</div>
          {/if}
        </div>
      {/each}

      <!-- Volumes -->
      <div class="flex items-center justify-between border-b border-edge px-2.5 py-1 text-caption uppercase tracking-wider text-muted">
        <span>{t("docker.volumes")}</span>
        <button class="flex items-center gap-1 rounded px-1 py-0.5 normal-case hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} onclick={() => run(pruneVolumesArgs(), { destructive: true, successKey: "docker.pruned" })}>
          <Icon name="trash" size={11} />{t("docker.prune")}
        </button>
      </div>
      {#each volumes as v (v.name)}
        <div class="group flex items-center gap-2 border-b border-edge/60 px-2.5 py-1.5 hover:bg-edge/30">
          <Icon name="database" size={14} class="shrink-0 text-accent" />
          <span class="min-w-0 flex-1 truncate text-text/90">{v.name}</span>
          <span class="shrink-0 text-caption text-muted">{v.driver}</span>
          <button class="shrink-0 rounded p-1 text-danger opacity-0 hover:bg-edge group-hover:opacity-100 disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={() => run(removeVolumeArgs([v.name]), { destructive: true, successKey: "docker.removed" })}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>
