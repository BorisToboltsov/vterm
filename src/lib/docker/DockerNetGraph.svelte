<script lang="ts">
  // The topology of the Docker host (v1.5, three columns since v1.33): the
  // published ports on the left, the containers with their addresses in the
  // middle, the networks with their subnets on the right — an edge per port and
  // per membership. The layout is a function of the data alone (buildNetGraph,
  // dockernet.ts), so a three-second poll cannot make it jump. Drawn the way
  // GitGraph draws its rails: fixed-height HTML rows under one SVG.
  //
  // Since v1.33 each node is a box (the first sketch of the topology): a port in
  // the colour of who can reach it, a container with its address on a second
  // line and its trouble in the colour of its frame, a network with its subnet,
  // an internal one dashed. A legend under the graph names the colours.
  //
  // An edge says "published to this container" or "attached to this network" and
  // nothing more. Picking a node lights what it shares a network with — what it
  // can reach in principle; the caption above the graph (DockerNetworks) says so.
  import EmptyState from "../ui/EmptyState.svelte";
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { stateTone, type DockerContainer, type DockerNetwork } from "./docker";
  import { buildNetGraph, graphFocus, type GraphEdge, type GraphPick, type GraphPort } from "./dockernet";
  import { t } from "../i18n";
  import { uiPx } from "../settings/settings.svelte";

  let {
    networks,
    containers,
    ips = undefined,
    subnets = undefined,
    trouble = undefined,
    onpick = undefined,
  }: {
    networks: DockerNetwork[];
    containers: DockerContainer[];
    /** A container's addresses, first shown (its facts); absent — not drawn. */
    ips?: (c: DockerContainer) => string[];
    /** Each network's subnets (`network inspect`); absent — not drawn. */
    subnets?: ReadonlyMap<string, { subnets: string[]; internal: boolean }>;
    /** What is wrong with a container, by the panel's «Needs attention»: its frame's colour. */
    trouble?: (id: string) => "warn" | "bad" | null;
    /** A node was picked twice in a row — open what it is (the details beside the list). */
    onpick?: (pick: GraphPick) => void;
  } = $props();

  const H = $derived(uiPx(40)); // fixed row height — the SVG is laid out in the same units
  const PAD = $derived(uiPx(4)); // breathing room above the first and below the last row
  const BOX = $derived(uiPx(34)); // a two-line box: name, and an address or a subnet
  const PORT = $derived(uiPx(24)); // a port is one line

  const TONE: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };
  // Who can reach a port: every address is an exposure, said in the warning colour.
  const REACH: Record<string, string> = {
    all: "border-warn text-warn",
    loopback: "border-edge text-muted",
    address: "border-edge text-text/85",
  };
  // A container in trouble says so by its frame — the same reading as the strip above the list.
  const FRAME: Record<string, string> = { warn: "border-warn bg-warn/5", bad: "border-bad bg-bad/5" };

  const graph = $derived(buildNetGraph(networks, containers, undefined, { ips, subnets }));
  // The SVG's x axis is in percent of the width (it stretches; strokes do not),
  // so the edges need no measured width: they run between the label columns.
  // Without published ports the graph is two columns.
  const cols = $derived(
    graph.ports.length > 0
      ? { ports: [0, 22], containers: [32, 66], networks: [76, 100] }
      : { ports: [0, 0], containers: [0, 40], networks: [60, 100] },
  );
  let pick = $state<GraphPick | null>(null);
  // A pick whose node is gone lights nothing (graphFocus returns null for it).
  const focus = $derived(graphFocus(graph, pick));
  const height = $derived(graph.rows * H + PAD * 2);
  const rowOfContainer = $derived(new Map(graph.containers.map((c) => [c.id, c.row])));

  const mid = (row: number) => PAD + row * H + H / 2;

  function curve(x1: number, y1: number, x2: number, y2: number): string {
    const cx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
  }
  const edgePath = (e: GraphEdge) => curve(cols.containers[1], mid(e.toRow), cols.networks[0], mid(e.fromRow));
  const portPath = (p: GraphPort) => curve(cols.ports[1], mid(p.row), cols.containers[0], mid(rowOfContainer.get(p.container) ?? p.row));

  const edgeLit = (e: GraphEdge) => !!focus && focus.networks.has(e.network) && focus.containers.has(e.container);
  const portLit = (p: GraphPort) => !!focus && focus.containers.has(p.container);

  const isPicked = (node: GraphPick) =>
    !!pick &&
    ((pick.kind === "network" && node.kind === "network" && pick.name === node.name) ||
      (pick.kind === "container" && node.kind === "container" && pick.id === node.id));

  /** Pick a node; picking the picked one again opens it, or clears the highlight. */
  function toggle(node: GraphPick) {
    if (isPicked(node)) {
      if (onpick) onpick(node);
      else pick = null;
      return;
    }
    pick = node;
  }

  /** Hover text of a container: its state, its addresses and every network it names. */
  function containerTip(c: (typeof graph.containers)[number]): string {
    const nets = c.mode ? [c.mode] : c.networks;
    return [c.name, c.state, c.ips.join(", "), nets.join(", ")].filter(Boolean).join(" · ");
  }
  const width = (span: number[]) => `${span[1] - span[0]}%`;
</script>

{#if graph.networks.length === 0 && graph.containers.length === 0}
  <EmptyState icon="network" title={t("docker.graphEmpty")} />
{:else}
  <div class="h-full overflow-auto text-xs" data-testid="docker-net-graph">
    <div class="sticky top-0 z-10 flex border-b border-edge bg-panel-alt text-meta font-medium text-muted">
      {#if graph.ports.length > 0}
        <span class="truncate px-2.5 py-1.5 text-right" style:width={width(cols.ports)}>{t("docker.graphPorts")}</span>
        <span style:width="{cols.containers[0] - cols.ports[1]}%"></span>
      {/if}
      <span class="truncate px-2.5 py-1.5" style:width={width(cols.containers)}>{t("docker.containers")}</span>
      <span class="flex-1"></span>
      <span class="truncate px-2.5 py-1.5" style:width={width(cols.networks)}>{t("docker.networks")}</span>
    </div>

    <div class="relative" style="height: {height}px">
      <!-- Edges: one SVG under the labels, stretched to the width. -->
      <svg
        class="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 {height}"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {#each graph.ports as p, i (i)}
          <path
            d={portPath(p)}
            fill="none"
            stroke={portLit(p) ? "var(--color-accent)" : p.reach === "all" ? "var(--color-warn)" : "var(--color-muted)"}
            stroke-width={portLit(p) ? 2 : 1.5}
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
            opacity={focus && !portLit(p) ? 0.2 : 0.75}
            data-testid="docker-net-port-edge"
          />
        {/each}
        {#each graph.edges as e (`${e.network}>${e.container}`)}
          <path
            d={edgePath(e)}
            fill="none"
            stroke={edgeLit(e) ? "var(--color-accent)" : "var(--color-muted)"}
            stroke-width={edgeLit(e) ? 2 : 1.5}
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
            opacity={focus && !edgeLit(e) ? 0.2 : 0.75}
            data-testid="docker-net-edge"
            data-lit={edgeLit(e)}
          />
        {/each}
      </svg>

      {#each graph.ports as p, i (i)}
        <!-- A port is the way into its container: picking it is picking the container. -->
        <button
          type="button"
          class="absolute flex items-center justify-end rounded border bg-panel-alt px-2 font-mono text-caption hover:bg-edge/40 {focus && !portLit(p) ? 'opacity-40' : ''} {REACH[p.reach]}"
          style="left: 0; width: {width(cols.ports)}; top: {PAD + p.row * H + (H - PORT) / 2}px; height: {PORT}px"
          use:tooltip={t(p.reach === "all" ? "docker.reachAll" : p.reach === "loopback" ? "docker.reachLoopback" : "docker.graphPortAddress")}
          data-testid="docker-net-port"
          data-reach={p.reach}
          onclick={() => toggle({ kind: "container", id: p.container })}
        >
          <span class="min-w-0 truncate">{p.label}</span>
        </button>
      {/each}

      {#each graph.containers as c (c.id)}
        {@const picked = isPicked({ kind: "container", id: c.id })}
        {@const wrong = trouble?.(c.id) ?? null}
        <button
          type="button"
          class="absolute flex flex-col justify-center rounded border px-2 text-left {wrong ? FRAME[wrong] : 'border-edge bg-panel-alt'} hover:bg-edge/40 {focus && !focus.containers.has(c.id) ? 'opacity-40' : ''} {picked ? 'ring-1 ring-accent' : ''}"
          style="left: {cols.containers[0]}%; width: {width(cols.containers)}; top: {PAD + c.row * H + (H - BOX) / 2}px; height: {BOX}px"
          aria-pressed={picked}
          use:tooltip={containerTip(c)}
          data-testid="docker-net-container"
          data-trouble={wrong ?? undefined}
          onclick={() => toggle({ kind: "container", id: c.id })}
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full {TONE[stateTone(c.state)]}"></span>
            <span class="min-w-0 truncate text-text/90">{c.name}</span>
          </span>
          <!-- `host` / `none`: a mode, not a network two containers meet on — no edge. -->
          <span class="min-w-0 truncate pl-3 font-mono text-caption text-muted" data-testid={c.mode ? undefined : c.ips.length ? "docker-net-ip" : undefined}>
            {c.mode ?? (c.ips.length > 0 ? c.ips.slice(0, 2).join(" · ") : "—")}
          </span>
        </button>
      {/each}

      {#each graph.networks as n (n.name)}
        {@const picked = isPicked({ kind: "network", name: n.name })}
        <button
          type="button"
          class="absolute flex flex-col justify-center rounded border bg-panel-alt px-2 text-left hover:bg-edge/40 {n.internal ? 'border-dashed' : ''} border-accent/60 {focus && !focus.networks.has(n.name) ? 'opacity-40' : ''} {picked ? 'ring-1 ring-accent' : ''}"
          style="left: {cols.networks[0]}%; width: {width(cols.networks)}; top: {PAD + n.row * H + (H - BOX) / 2}px; height: {BOX}px"
          aria-pressed={picked}
          use:tooltip={[n.name, n.subnets.join(", "), n.internal ? t("docker.netInternal") : ""].filter(Boolean).join(" · ")}
          data-testid="docker-net-node"
          data-internal={n.internal || undefined}
          onclick={() => toggle({ kind: "network", name: n.name })}
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <Icon name="network" size={12} class="shrink-0 {picked ? 'text-accent' : 'text-muted'}" />
            <span class="min-w-0 truncate text-text/90">{n.name}</span>
            <span class="ml-auto shrink-0 text-caption tabular-nums text-muted">{n.members}</span>
          </span>
          {#if n.subnets.length > 0 || n.internal}
            <span class="min-w-0 truncate pl-[1.125rem] font-mono text-caption text-muted" data-testid="docker-net-subnet">
              {[n.subnets[0] ?? "", n.internal ? t("docker.graphInternal") : ""].filter(Boolean).join(" · ")}
            </span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- What the colours say: who reaches a port, what is wrong, what stays inside. -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge/60 px-2.5 py-1.5 text-caption text-muted" data-testid="docker-net-legend">
      {#if graph.ports.length > 0}
        <span class="flex items-center gap-1.5"><span class="h-2.5 w-3.5 rounded-sm border border-warn"></span>{t("docker.graphLegendAll")}</span>
        <span class="flex items-center gap-1.5"><span class="h-2.5 w-3.5 rounded-sm border border-edge"></span>{t("docker.graphLegendLocal")}</span>
      {/if}
      <span class="flex items-center gap-1.5"><span class="h-2.5 w-3.5 rounded-sm border border-bad bg-bad/5"></span>{t("docker.graphLegendTrouble")}</span>
      <span class="flex items-center gap-1.5"><span class="h-2.5 w-3.5 rounded-sm border border-dashed border-accent/60"></span>{t("docker.graphLegendInternal")}</span>
    </div>

    {#if graph.hidden > 0}
      <div class="border-t border-edge/60 px-2.5 py-1.5 text-caption text-muted" data-testid="docker-net-more">
        {t("docker.graphMore", { n: graph.hidden })}
      </div>
    {/if}
  </div>
{/if}
