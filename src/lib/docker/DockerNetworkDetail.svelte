<script lang="ts">
  // A network's details beside the list (v1.33, stage 4): its driver, its
  // address ranges and gateway, whether it reaches outside the host, and every
  // container on it with the address the network gave it — docker's own answer
  // (`network inspect`), a click opens a container. Content only, no dialog.
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { removeNetworkArgs } from "./docker";
  import { networkInspectArgs, parseNetworkDetail, type NetworkDetail } from "./dockeritems";
  import { isSharedNetwork } from "./dockernet";
  import type { ContainerOutput } from "../api";
  import { t } from "../i18n";

  let {
    name,
    busy = false,
    refreshSec = 3,
    run,
    runQuery,
    onopen,
    onclose,
  }: {
    name: string | null;
    busy?: boolean;
    refreshSec?: number;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string; label?: string }) => Promise<boolean>;
    runQuery: (args: string[], timeout?: number) => Promise<ContainerOutput>;
    onopen: (id: string) => void;
    onclose: () => void;
  } = $props();

  let net = $state<NetworkDetail | null | undefined>(undefined);
  async function load(n: string) {
    try {
      const res = await runQuery(networkInspectArgs(n));
      if (name === n) net = res.exitCode === 0 ? parseNetworkDetail(res.stdout) : null;
    } catch {
      if (name === n) net = null;
    }
  }
  $effect(() => {
    const n = name;
    if (!n) return;
    net = undefined;
    void load(n);
    const timer = setInterval(() => void load(n), Math.max(5, refreshSec) * 1000);
    return () => clearInterval(timer);
  });
  const SECTION = "mb-1 mt-3 flex items-center gap-1.5 text-caption uppercase tracking-wider text-muted";

  async function remove() {
    if (!name) return;
    const ok = await run(removeNetworkArgs([name]), { destructive: true, successKey: "docker.removed" });
    if (ok) onclose();
  }
</script>

{#if name}
  <div class="min-h-0 flex-1 overflow-auto text-meta" data-testid="docker-network-detail">
    {#if net === undefined}
      <p class="text-muted">…</p>
    {:else if net === null}
      <p class="text-muted">{t("docker.itemUnread")}</p>
    {:else}
      <div class="mb-2 flex items-center gap-2">
        <Icon name="network" size={14} class="shrink-0 text-accent" />
        <div class="min-w-0 flex-1 truncate text-muted">{net.driver} · {net.scope}</div>
        {#if isSharedNetwork(net.name) && net.name !== "bridge"}
          <button class="rounded p-1 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={remove}>
            <Icon name="trash" size={14} />
          </button>
        {/if}
      </div>
      <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
        {#each net.subnets as sn, i (i)}
          <dt class="text-muted">{t("docker.netSubnet")}</dt>
          <dd class="font-mono text-text/85">{sn.subnet || "—"}{#if sn.gateway}<span class="text-muted">{` · ${t("docker.netGateway")} ${sn.gateway}`}</span>{/if}</dd>
        {/each}
        <dt class="text-muted">{t("docker.netOutside")}</dt>
        <dd class={net.internal ? "text-warn" : "text-text/85"} data-testid="docker-network-internal">{t(net.internal ? "docker.netInternal" : "docker.netNotInternal")}</dd>
      </dl>
      <h4 class={SECTION}>{t("docker.containers")} <span class="tabular-nums">{net.members.length}</span></h4>
      {#if net.members.length === 0}
        <p class="text-muted">{t("docker.itemNoUsers")}</p>
      {:else}
        <div data-testid="docker-network-members">
          {#each net.members as m (m.id)}
            <button type="button" class="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-edge/30" onclick={() => onopen(m.id)}>
              <span class="min-w-0 flex-1 truncate text-text/90">{m.name}</span>
              <span class="shrink-0 font-mono text-text/85">{m.ipv4 || m.ipv6 || "—"}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
{/if}
