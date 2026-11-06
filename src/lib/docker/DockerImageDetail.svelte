<script lang="ts">
  // An image's details beside the list (v1.33, stage 4): what it is, what it
  // takes and frees, which containers run it, its layers with the step that made
  // each. Content only — it stands inside the panel's query container and owns
  // no dialog (`panelcontainer.guard`). Read-only asks; removal goes through the
  // panel's `run`, which confirms.
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import DockerItemUsers from "./DockerItemUsers.svelte";
  import { dockerDate, imageContainers, removeImageArgs, type DiskDetail, type DockerImage } from "./docker";
  import { imageHistoryArgs, imageUsersArgs, parseHistory, parseUsers, type ImageLayer, type UserContainer } from "./dockeritems";
  import type { ContainerOutput } from "../api";
  import { t, currentLocale } from "../i18n";

  let {
    image,
    detail = undefined,
    busy = false,
    refreshSec = 3,
    run,
    runQuery,
    onopen,
    onclose,
  }: {
    image: DockerImage | null;
    /** Who uses what, by docker's count (`system df -v`); absent — not known. */
    detail?: DiskDetail | null;
    busy?: boolean;
    refreshSec?: number;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string; label?: string }) => Promise<boolean>;
    runQuery: (args: string[], timeout?: number) => Promise<ContainerOutput>;
    /** Open a container's details. */
    onopen: (id: string) => void;
    onclose: () => void;
  } = $props();

  let users = $state<UserContainer[] | null | undefined>(undefined);
  let layers = $state<ImageLayer[] | null | undefined>(undefined);

  async function load(id: string) {
    const [u, h] = await Promise.allSettled([runQuery(imageUsersArgs(id)), runQuery(imageHistoryArgs(id), 30)]);
    if (image?.id !== id) return;
    users = u.status === "fulfilled" && u.value.exitCode === 0 ? parseUsers(u.value.stdout) : null;
    layers = h.status === "fulfilled" && h.value.exitCode === 0 ? parseHistory(h.value.stdout) : null;
  }
  // Asked when the image opens and again with the panel's poll: who runs it changes.
  $effect(() => {
    const id = image?.id;
    if (!id) return;
    users = undefined;
    layers = undefined;
    void load(id);
    const timer = setInterval(() => void load(id), Math.max(5, refreshSec) * 1000);
    return () => clearInterval(timer);
  });

  const unique = $derived.by(() => {
    if (!image || !detail) return "";
    const short = image.id.replace(/^sha256:/, "");
    const key = [...detail.imageUnique.keys()].find((id) => id.startsWith(short));
    return key ? (detail.imageUnique.get(key) ?? "") : "";
  });
  const SECTION = "mb-1 mt-3 flex items-center gap-1.5 text-caption uppercase tracking-wider text-muted";

  async function remove() {
    if (!image) return;
    const ok = await run(removeImageArgs([image.id], true), {
      destructive: true,
      successKey: "docker.removed",
      label: `docker rmi -f ${image.repository}:${image.tag}`,
    });
    if (ok) onclose();
  }
</script>

{#if image}
  <div class="min-h-0 flex-1 overflow-auto text-meta" data-testid="docker-image-detail">
    <div class="mb-2 flex items-center gap-2">
      <Icon name="container" size={14} class="shrink-0 text-accent" />
      <div class="min-w-0 flex-1 truncate font-mono text-text/85">{image.id}</div>
      <button class="rounded p-1 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} use:tooltip={t("docker.removeImage")} aria-label={t("docker.removeImage")} onclick={remove}>
        <Icon name="trash" size={14} />
      </button>
    </div>
    <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
      <dt class="text-muted">{t("docker.image")}</dt>
      <dd class="break-all text-text/85">{image.repository}<span class="text-muted">:{image.tag}</span></dd>
      <dt class="text-muted">{t("docker.size")}</dt>
      <dd class="text-text/85">{image.size}{#if unique}<span class="text-muted">{` · ${t("docker.imageFrees", { size: unique })}`}</span>{/if}</dd>
      <dt class="text-muted">{t("docker.created")}</dt>
      <dd class="text-text/85">{dockerDate(image.created, currentLocale())}</dd>
      {#if imageContainers(image, detail) != null}
        <dt class="text-muted">{t("docker.imageUse")}</dt>
        <dd class="text-text/85">{t("docker.imageUsedBy", { n: imageContainers(image, detail) ?? 0 })}</dd>
      {/if}
    </dl>

    <h4 class={SECTION}>{t("docker.itemUsers")}</h4>
    <DockerItemUsers {users} {onopen} testid="docker-image-users" />

    <h4 class={SECTION}>{t("docker.imageLayers")} {#if layers}<span class="tabular-nums">{layers.length}</span>{/if}</h4>
    {#if layers === undefined}
      <p class="text-muted">…</p>
    {:else if layers === null}
      <p class="text-muted">{t("docker.imageLayersUnread")}</p>
    {:else}
      <ul class="space-y-0.5" data-testid="docker-image-layers">
        {#each layers as l, i (i)}
          <li class="flex min-w-0 items-baseline gap-2 px-1">
            <span class="w-16 shrink-0 text-right tabular-nums {l.adds ? 'text-text/85' : 'text-muted'}">{l.size}</span>
            <span class="min-w-0 flex-1 truncate font-mono {l.adds ? 'text-text/85' : 'text-muted'}" use:tooltip={l.step}>{l.step || "—"}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
