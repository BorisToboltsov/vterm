<script lang="ts">
  // Image list for the Docker panel (Phase 35). Presentational + action wiring;
  // arg building is pure (docker.ts). Per-row remove (destructive → prod-confirmed
  // by the orchestrator's `run`); "prune unused" stands in the list's header row,
  // the grouping by repository comes from `listview.ts` (v1.29).
  import Icon from "../ui/Icon.svelte";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import { tooltip } from "../actions/tooltip";
  import { removeImageArgs, dockerAge, dockerDate, imageContainers, type DiskDetail, type DockerImage } from "./docker";
  import type { MenuItem } from "../ui/ctxmenu";
  import type { ListGroup } from "../ui/listview";
  import { t, currentLocale } from "../i18n";

  let {
    groups,
    grouped = false,
    collapsed = [],
    ontoggle = () => {},
    busy = false,
    detail = undefined,
    run,
    onInspect,
    showMenu,
  }: {
    /** The list as `listview.ts` lays it out; one group without a header when not grouped. */
    groups: ListGroup<DockerImage>[];
    grouped?: boolean;
    collapsed?: readonly string[];
    ontoggle?: (key: string) => void;
    busy?: boolean;
    /** Who uses what, by docker's count (`system df -v`, v1.33); absent — not known. */
    detail?: DiskDetail | null;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
    onInspect: (img: DockerImage) => void;
    /** Open the shared context menu at the event position with these items. */
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  /**
   * Hover card on the name: the untruncated reference plus the two facts the row
   * cross-fades away under the pointer (`.vt-tooltip` keeps newlines).
   */
  function infoTip(img: DockerImage): string {
    const used = imageContainers(img, detail);
    const unique = detail?.imageUnique.get([...detail.imageUnique.keys()].find((id) => id.startsWith(img.id.replace(/^sha256:/, ""))) ?? "");
    return [
      `${img.repository}:${img.tag}`,
      img.size,
      `${t("docker.created")}: ${dockerDate(img.created, currentLocale())}`,
      used != null ? t("docker.imageUsedBy", { n: used }) : "",
      unique ? t("docker.imageFrees", { size: unique }) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

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

<!-- The prune button stands in the list's header row (DockerPanel). -->
<div class="h-full overflow-auto text-xs">
  {#each groups as g (g.key)}
    {@const folded = grouped && collapsed.includes(g.key)}
    {#if grouped}
      <GroupHeader
        label={g.rest ? t("docker.imageDangling") : g.label}
        count={g.items.length}
        collapsed={folded}
        ontoggle={() => ontoggle(g.key)}
        rest={g.rest}
        testid="docker-image-group"
      />
    {/if}
    {#each folded ? [] : g.items as img (img.id + img.repository + img.tag)}
      <div class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2.5 hover:bg-edge/30 {grouped ? 'pl-5' : 'pl-2.5'}" oncontextmenu={(e) => showMenu(e, menuItems(img))} role="listitem">
        <Icon name="container" size={14} class="shrink-0 text-accent" />
        <div class="min-w-0 flex-1 truncate" use:tooltip={infoTip(img)}>
          <span class="text-text/90">{img.repository}</span><span class="text-muted">:{img.tag}</span>
        </div>
        {#if imageContainers(img, detail) === 0}
          <!-- Not used by any container, by docker's own count: what a prune of unused images takes. -->
          <span class="shrink-0 text-caption text-muted" data-testid="docker-image-unused">{t("docker.imageUnused")}</span>
        {/if}
        <!-- Size + age and the hover action share one reserved box, cross-faded
             (same no-reflow rule as the container rows): a button of its own
             cost 25px of every row, and the image name is what gets truncated. -->
        <div class="relative flex shrink-0 items-center gap-2 text-caption tabular-nums">
          <span class="w-12 text-right text-text/50 transition-opacity duration-150 group-hover:opacity-0">{img.size}</span>
          <span class="w-9 text-right text-muted transition-opacity duration-150 group-hover:opacity-0">{dockerAge(img.created)}</span>
          <button class="absolute right-0 rounded p-1 text-danger opacity-0 transition-opacity duration-150 hover:bg-edge group-hover:opacity-100 disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={() => run(removeImageArgs([img.id], true), { destructive: true, successKey: "docker.removed" })}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      </div>
    {/each}
  {/each}
</div>
