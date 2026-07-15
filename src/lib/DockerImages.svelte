<script lang="ts">
  // Image list for the Docker panel (Phase 35). Presentational + action wiring;
  // arg building is pure (docker.ts). Per-row remove + a "prune unused" header
  // action (both destructive → prod-confirmed by the orchestrator's `run`).
  import Icon from "./Icon.svelte";
  import EmptyState from "./EmptyState.svelte";
  import { tooltip } from "./actions/tooltip";
  import { removeImageArgs, pruneImagesArgs, type DockerImage } from "./docker";
  import type { MenuItem } from "./ctxmenu";
  import { t } from "./i18n";

  let {
    images,
    busy = false,
    run,
    onInspect,
    showMenu,
  }: {
    images: DockerImage[];
    busy?: boolean;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
    onInspect: (img: DockerImage) => void;
    /** Open the shared context menu at the event position with these items. */
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  function copyId(img: DockerImage) {
    void navigator.clipboard?.writeText(img.id);
  }

  // Right-click menu (Phase 36, point 5). No CVE scan — the app can't run one.
  function menuItems(img: DockerImage): MenuItem[] {
    return [
      { icon: "braces", label: t("docker.inspect"), onSelect: () => onInspect(img) },
      { icon: "copy", label: t("docker.copyId"), onSelect: () => copyId(img) },
      { kind: "separator" },
      { icon: "trash", label: t("docker.removeImage"), danger: true, onSelect: () => run(removeImageArgs([img.id], true), { destructive: true, successKey: "docker.removed" }) },
    ];
  }
</script>

{#if images.length === 0}
  <EmptyState icon="container" title={t("docker.noImages")} />
{:else}
  <div class="h-full overflow-auto text-xs">
    <div class="flex justify-end border-b border-edge px-2 py-1">
      <button class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} onclick={() => run(pruneImagesArgs(), { destructive: true, successKey: "docker.pruned" })}>
        <Icon name="trash" size={12} />
        {t("docker.pruneImages")}
      </button>
    </div>
    {#each images as img (img.id + img.repository + img.tag)}
      <div class="group flex items-center gap-2 border-b border-edge/60 px-2.5 py-1.5 hover:bg-edge/30" oncontextmenu={(e) => showMenu(e, menuItems(img))} role="listitem">
        <Icon name="container" size={14} class="shrink-0 text-accent" />
        <div class="min-w-0 flex-1 truncate">
          <span class="text-white/90">{img.repository}</span><span class="text-muted">:{img.tag}</span>
        </div>
        <span class="shrink-0 text-[10px] text-white/50">{img.size}</span>
        <span class="w-20 shrink-0 truncate text-right text-[10px] text-muted" use:tooltip={img.created}>{img.created}</span>
        <button class="shrink-0 rounded p-1 text-danger opacity-0 hover:bg-edge group-hover:opacity-100 disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={() => run(removeImageArgs([img.id], true), { destructive: true, successKey: "docker.removed" })}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    {/each}
  </div>
{/if}
