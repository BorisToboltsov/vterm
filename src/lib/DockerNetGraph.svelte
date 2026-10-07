<script lang="ts">
  // Network membership graph of the Docker panel (v1.5): networks on the left,
  // containers on the right, an edge per membership. Bipartite, so it is two
  // sorted columns (buildNetGraph, dockernet.ts) — the layout is a function of
  // the data alone and a three-second poll cannot make it jump. Drawn the way
  // GitGraph draws its rails: fixed-height HTML rows under one SVG.
  //
  // An edge says "attached to this network" and nothing more. Picking a node
  // lights what it shares a network with — what it can reach in principle; the
  // caption above the graph (DockerNetworks) says so in words.
  import EmptyState from "./EmptyState.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { stateTone, type DockerContainer, type DockerNetwork } from "./docker";
  import { buildNetGraph, graphFocus, type GraphEdge, type GraphPick } from "./dockernet";
  import { t } from "./i18n";

  let {
    networks,
    containers,
  }: {
    networks: DockerNetwork[];
    containers: DockerContainer[];
  } = $props();

  const H = 26; // fixed row height — the SVG is laid out in the same units
  const PAD = 4; // breathing room above the first and below the last row
  // The SVG's x axis is in percent of the width (it stretches; strokes do not),
  // so the edges need no measured width: they run between the two label columns.
  const LEFT = 38;
  const RIGHT = 62;

  const TONE: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };

  const graph = $derived(buildNetGraph(networks, containers));
  let pick = $state<GraphPick | null>(null);
  // A pick whose node is gone lights nothing (graphFocus returns null for it).
  const focus = $derived(graphFocus(graph, pick));
  const height = $derived(graph.rows * H + PAD * 2);

  const mid = (row: number) => PAD + row * H + H / 2;

  function edgePath(e: GraphEdge): string {
    const y1 = mid(e.fromRow);
    const y2 = mid(e.toRow);
    const cx = (LEFT + RIGHT) / 2;
    return `M${LEFT} ${y1} C${cx} ${y1} ${cx} ${y2} ${RIGHT} ${y2}`;
  }

  const edgeLit = (e: GraphEdge) => !!focus && focus.networks.has(e.network) && focus.containers.has(e.container);

  const isPicked = (node: GraphPick) =>
    !!pick &&
    ((pick.kind === "network" && node.kind === "network" && pick.name === node.name) ||
      (pick.kind === "container" && node.kind === "container" && pick.id === node.id));

  /** Pick a node; picking the picked one again clears the highlight. */
  function toggle(node: GraphPick) {
    pick = isPicked(node) ? null : node;
  }

  /** Hover text of a container: its state and every network it names. */
  function containerTip(c: (typeof graph.containers)[number]): string {
    const nets = c.mode ? [c.mode] : c.networks;
    return [c.name, c.state, nets.join(", ")].filter(Boolean).join(" · ");
  }
</script>

{#if graph.networks.length === 0 && graph.containers.length === 0}
  <EmptyState icon="network" title={t("docker.graphEmpty")} />
{:else}
  <div class="h-full overflow-auto text-xs" data-testid="docker-net-graph">
    <div class="sticky top-0 z-10 flex border-b border-edge bg-panel-alt text-meta font-medium text-muted">
      <span class="w-[38%] truncate px-2.5 py-1.5 text-right">{t("docker.networks")}</span>
      <span class="flex-1"></span>
      <span class="w-[38%] truncate px-2.5 py-1.5">{t("docker.containers")}</span>
    </div>

    <div class="relative" style="height: {height}px">
      <!-- Edges: one SVG under the labels, stretched to the width. -->
      <svg
        class="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 {height}"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
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

      {#each graph.networks as n (n.name)}
        {@const picked = isPicked({ kind: "network", name: n.name })}
        <button
          type="button"
          class="absolute left-0 flex w-[38%] items-center justify-end gap-1.5 pl-2.5 pr-1 text-left hover:bg-edge/30 {focus && !focus.networks.has(n.name) ? 'opacity-40' : ''} {picked ? 'bg-edge/60' : ''}"
          style="top: {PAD + n.row * H}px; height: {H}px"
          aria-pressed={picked}
          use:tooltip={n.name}
          data-testid="docker-net-node"
          onclick={() => toggle({ kind: "network", name: n.name })}
        >
          <span class="shrink-0 text-caption tabular-nums text-muted">{n.members}</span>
          <span class="min-w-0 truncate text-text/90">{n.name}</span>
          <Icon name="network" size={13} class="shrink-0 {picked ? 'text-accent' : 'text-muted'}" />
        </button>
      {/each}

      {#each graph.containers as c (c.id)}
        {@const picked = isPicked({ kind: "container", id: c.id })}
        <button
          type="button"
          class="absolute right-0 flex w-[38%] items-center gap-1.5 pl-1 pr-2.5 text-left hover:bg-edge/30 {focus && !focus.containers.has(c.id) ? 'opacity-40' : ''} {picked ? 'bg-edge/60' : ''}"
          style="top: {PAD + c.row * H}px; height: {H}px"
          aria-pressed={picked}
          use:tooltip={containerTip(c)}
          data-testid="docker-net-container"
          onclick={() => toggle({ kind: "container", id: c.id })}
        >
          <span class="h-[7px] w-[7px] shrink-0 rounded-full {TONE[stateTone(c.state)]}"></span>
          <span class="min-w-0 truncate text-text/90">{c.name}</span>
          {#if c.mode}
            <!-- `host` / `none`: a mode, not a network two containers meet on — no edge. -->
            <span class="shrink-0 text-caption text-muted">{c.mode}</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if graph.hidden > 0}
      <div class="border-t border-edge/60 px-2.5 py-1.5 text-caption text-muted" data-testid="docker-net-more">
        {t("docker.graphMore", { n: graph.hidden })}
      </div>
    {/if}
  </div>
{/if}
