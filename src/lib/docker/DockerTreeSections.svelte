<script lang="ts">
  // The rest of the column of names (v1.33, stage 4): with details open beside
  // the list, the containers' column goes on with the images, the networks and
  // the volumes — one column to pick anything from, the details of the picked
  // one beside it (JetBrains' Services, lazydocker). Each section folds; a row
  // opens its item's details. The full tables stay in the sub-tabs above.
  import GroupHeader from "../ui/GroupHeader.svelte";
  import Icon from "../ui/Icon.svelte";
  import { imageContainers, type DiskDetail, type DockerImage, type DockerNetwork, type DockerVolume } from "./docker";
  import { sameItem, type DockerItem } from "./dockeritems";
  import { isSharedNetwork } from "./dockernet";
  import { t } from "../i18n";

  let {
    images,
    networks,
    volumes,
    usage = undefined,
    picked = null,
    onpick,
  }: {
    images: readonly DockerImage[];
    networks: readonly DockerNetwork[];
    volumes: readonly DockerVolume[];
    usage?: DiskDetail | null;
    /** The item whose details are open: its row is marked. */
    picked?: DockerItem | null;
    onpick: (item: DockerItem) => void;
  } = $props();

  // Folded until asked for: the containers are what the column is opened for.
  let open = $state<Record<string, boolean>>({ images: false, networks: false, volumes: false });
  const ROW = "flex w-full min-w-0 items-center gap-2 border-b border-edge/60 py-1 pl-5 pr-2 text-left";
  const mark = (item: DockerItem) => (sameItem(picked, item) ? "bg-accent/10" : "hover:bg-edge/30");
  const shared = $derived(networks.filter((n) => isSharedNetwork(n.name)));
</script>

<div data-testid="docker-tree-sections">
  <GroupHeader label={t("docker.images")} count={images.length} collapsed={!open.images} ontoggle={() => (open.images = !open.images)} icon="container" testid="docker-tree-images" />
  {#if open.images}
    {#each images as img (img.id + img.repository + img.tag)}
      {@const item = { kind: "image", id: img.id, label: `${img.repository}:${img.tag}` } as const}
      <button type="button" class="{ROW} {mark(item)}" aria-current={sameItem(picked, item) ? "true" : undefined} data-testid="docker-tree-image" onclick={() => onpick(item)}>
        <span class="min-w-0 flex-1 truncate"><span class="text-text/90">{img.repository}</span><span class="text-muted">:{img.tag}</span></span>
        {#if imageContainers(img, usage) === 0}<span class="shrink-0 text-caption text-muted">{t("docker.imageUnused")}</span>{/if}
      </button>
    {/each}
  {/if}
  <GroupHeader label={t("docker.networks")} count={shared.length} collapsed={!open.networks} ontoggle={() => (open.networks = !open.networks)} icon="network" testid="docker-tree-networks" />
  {#if open.networks}
    {#each shared as n (n.id || n.name)}
      {@const item = { kind: "network", name: n.name } as const}
      <button type="button" class="{ROW} {mark(item)}" aria-current={sameItem(picked, item) ? "true" : undefined} data-testid="docker-tree-network" onclick={() => onpick(item)}>
        <Icon name="network" size={12} class="shrink-0 text-muted" />
        <span class="min-w-0 flex-1 truncate text-text/90">{n.name}</span>
        <span class="shrink-0 text-caption text-muted">{n.driver}</span>
      </button>
    {/each}
  {/if}
  <GroupHeader label={t("docker.volumes")} count={volumes.length} collapsed={!open.volumes} ontoggle={() => (open.volumes = !open.volumes)} icon="database" testid="docker-tree-volumes" />
  {#if open.volumes}
    {#each volumes as v (v.name)}
      {@const item = { kind: "volume", name: v.name } as const}
      {@const u = usage?.volumes.get(v.name)}
      <button type="button" class="{ROW} {mark(item)}" aria-current={sameItem(picked, item) ? "true" : undefined} data-testid="docker-tree-volume" onclick={() => onpick(item)}>
        <Icon name="database" size={12} class="shrink-0 text-muted" />
        <span class="min-w-0 flex-1 truncate text-text/90">{v.name}</span>
        {#if u?.links === 0}<span class="shrink-0 text-caption text-warn">{t("docker.volumeUnused")}</span>{/if}
        {#if u?.size && u.size !== "N/A"}<span class="shrink-0 text-caption tabular-nums text-muted">{u.size}</span>{/if}
      </button>
    {/each}
  {/if}
</div>
