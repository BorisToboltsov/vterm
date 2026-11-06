<script lang="ts">
  // A volume's details beside the list (v1.33, stage 4): where its data lives,
  // how big it is, whether docker made it for one container (anonymous), and
  // which containers mount it — asked of docker by filter. Content only.
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import DockerItemUsers from "./DockerItemUsers.svelte";
  import { removeVolumeArgs, type DiskDetail } from "./docker";
  import { parseUsers, parseVolumeDetail, volumeInspectArgs, volumeUsersArgs, type UserContainer, type VolumeDetail } from "./dockeritems";
  import type { ContainerOutput } from "../api";
  import { t, currentLocale } from "../i18n";

  let {
    name,
    usage = undefined,
    busy = false,
    refreshSec = 3,
    run,
    runQuery,
    onopen,
    onclose,
  }: {
    name: string | null;
    /** Its size and links, by docker's count (`system df -v`); absent — not known. */
    usage?: DiskDetail | null;
    busy?: boolean;
    refreshSec?: number;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string; label?: string }) => Promise<boolean>;
    runQuery: (args: string[], timeout?: number) => Promise<ContainerOutput>;
    onopen: (id: string) => void;
    onclose: () => void;
  } = $props();

  let vol = $state<VolumeDetail | null | undefined>(undefined);
  let users = $state<UserContainer[] | null | undefined>(undefined);
  async function load(n: string) {
    const [v, u] = await Promise.allSettled([runQuery(volumeInspectArgs(n)), runQuery(volumeUsersArgs(n))]);
    if (name !== n) return;
    vol = v.status === "fulfilled" && v.value.exitCode === 0 ? parseVolumeDetail(v.value.stdout) : null;
    users = u.status === "fulfilled" && u.value.exitCode === 0 ? parseUsers(u.value.stdout) : null;
  }
  $effect(() => {
    const n = name;
    if (!n) return;
    vol = undefined;
    users = undefined;
    void load(n);
    const timer = setInterval(() => void load(n), Math.max(5, refreshSec) * 1000);
    return () => clearInterval(timer);
  });
  const size = $derived(name ? usage?.volumes.get(name)?.size : undefined);
  const SECTION = "mb-1 mt-3 flex items-center gap-1.5 text-caption uppercase tracking-wider text-muted";
  const date = (ms: number) => new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: "short" }).format(ms);

  async function remove() {
    if (!name) return;
    const ok = await run(removeVolumeArgs([name]), { destructive: true, successKey: "docker.removed" });
    if (ok) onclose();
  }
</script>

{#if name}
  <div class="min-h-0 flex-1 overflow-auto text-meta" data-testid="docker-volume-detail">
    {#if vol === undefined}
      <p class="text-muted">…</p>
    {:else if vol === null}
      <p class="text-muted">{t("docker.itemUnread")}</p>
    {:else}
      <div class="mb-2 flex items-center gap-2">
        <Icon name="database" size={14} class="shrink-0 text-accent" />
        <div class="min-w-0 flex-1 truncate text-muted">{vol.driver} · {vol.scope}{#if vol.anonymous}{` · ${t("docker.volAnonymous")}`}{/if}</div>
        <button class="rounded p-1 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={remove}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
        <dt class="text-muted">{t("docker.volPath")}</dt>
        <dd class="break-all font-mono text-text/85" data-testid="docker-volume-path">{vol.mountpoint || "—"}</dd>
        {#if size && size !== "N/A"}
          <dt class="text-muted">{t("docker.size")}</dt>
          <dd class="tabular-nums text-text/85">{size}</dd>
        {/if}
        {#if vol.created != null}
          <dt class="text-muted">{t("docker.created")}</dt>
          <dd class="text-text/85">{date(vol.created)}</dd>
        {/if}
      </dl>
      <p class="mt-1 text-caption text-muted">{t("docker.volPathHint")}</p>
    {/if}
    <h4 class={SECTION}>{t("docker.itemUsers")}</h4>
    <DockerItemUsers {users} {onopen} testid="docker-volume-users" />
  </div>
{/if}
