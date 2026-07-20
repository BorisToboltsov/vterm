<script lang="ts">
  // Networks + volumes for the Docker panel (Phase 35), two sections in one
  // sub-tab. Presentational + action wiring; arg building is pure (docker.ts).
  // Per-row remove + per-section "prune" (both destructive → prod-confirmed by
  // the orchestrator's `run`).
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    removeNetworkArgs,
    removeVolumeArgs,
    pruneNetworksArgs,
    pruneVolumesArgs,
    type DockerNetwork,
    type DockerVolume,
  } from "./docker";
  import { t } from "./i18n";

  let {
    networks,
    volumes,
    busy = false,
    run,
  }: {
    networks: DockerNetwork[];
    volumes: DockerVolume[];
    busy?: boolean;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
  } = $props();
</script>

<div class="h-full overflow-auto text-xs">
  <!-- Networks -->
  <div class="flex items-center justify-between border-b border-edge px-2.5 py-1 text-caption uppercase tracking-wider text-muted">
    <span>{t("docker.networks")}</span>
    <button class="flex items-center gap-1 rounded px-1 py-0.5 normal-case hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} onclick={() => run(pruneNetworksArgs(), { destructive: true, successKey: "docker.pruned" })}>
      <Icon name="trash" size={11} />{t("docker.prune")}
    </button>
  </div>
  {#each networks as n (n.id)}
    <div class="group flex items-center gap-2 border-b border-edge/60 px-2.5 py-1.5 hover:bg-edge/30">
      <Icon name="network" size={14} class="shrink-0 text-accent" />
      <span class="min-w-0 flex-1 truncate text-white/90">{n.name}</span>
      <span class="shrink-0 text-caption text-muted">{n.driver} · {n.scope}</span>
      <button class="shrink-0 rounded p-1 text-danger opacity-0 hover:bg-edge group-hover:opacity-100 disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={() => run(removeNetworkArgs([n.id]), { destructive: true, successKey: "docker.removed" })}>
        <Icon name="trash" size={13} />
      </button>
    </div>
  {/each}

  <!-- Volumes -->
  <div class="flex items-center justify-between border-b border-edge px-2.5 py-1 text-caption uppercase tracking-wider text-muted">
    <span>{t("docker.volumes")}</span>
    <button class="flex items-center gap-1 rounded px-1 py-0.5 normal-case hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} onclick={() => run(pruneVolumesArgs(), { destructive: true, successKey: "docker.pruned" })}>
      <Icon name="trash" size={11} />{t("docker.prune")}
    </button>
  </div>
  {#each volumes as v (v.name)}
    <div class="group flex items-center gap-2 border-b border-edge/60 px-2.5 py-1.5 hover:bg-edge/30">
      <Icon name="database" size={14} class="shrink-0 text-accent" />
      <span class="min-w-0 flex-1 truncate text-white/90">{v.name}</span>
      <span class="shrink-0 text-caption text-muted">{v.driver}</span>
      <button class="shrink-0 rounded p-1 text-danger opacity-0 hover:bg-edge group-hover:opacity-100 disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={() => run(removeVolumeArgs([v.name]), { destructive: true, successKey: "docker.removed" })}>
        <Icon name="trash" size={13} />
      </button>
    </div>
  {/each}
</div>
