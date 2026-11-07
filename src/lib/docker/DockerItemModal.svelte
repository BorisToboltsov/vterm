<script lang="ts">
  // An image's, a network's, a volume's or a stack's details as a dialog (v1.33,
  // stage 5) — where the panel has no room to show them beside its list. The
  // content is the same component a wide panel puts into its `SidePane`; the
  // dialog stays out of the content (`panelcontainer.guard`).
  import Modal from "../ui/Modal.svelte";
  import DockerImageDetail from "./DockerImageDetail.svelte";
  import DockerNetworkDetail from "./DockerNetworkDetail.svelte";
  import DockerVolumeDetail from "./DockerVolumeDetail.svelte";
  import DockerStackDetail from "./DockerStackDetail.svelte";
  import type { DiskDetail, DockerImage } from "./docker";
  import type { DockerItem } from "./dockeritems";
  import type { DockerStack } from "./dockerstack";
  import type { ContainerOutput } from "../api";

  let {
    open = false,
    item,
    image = null,
    stack = null,
    usage = undefined,
    busy = false,
    refreshSec = 3,
    run,
    runQuery,
    onopen,
    onclose,
  }: {
    open?: boolean;
    item: DockerItem | null;
    /** The image an image item names, as the list holds it. */
    image?: DockerImage | null;
    /** The stack a stack item names, as its containers' labels describe it. */
    stack?: DockerStack | null;
    usage?: DiskDetail | null;
    busy?: boolean;
    refreshSec?: number;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string; label?: string }) => Promise<boolean>;
    runQuery: (args: string[], timeout?: number) => Promise<ContainerOutput>;
    onopen: (id: string) => void;
    onclose: () => void;
  } = $props();

  const title = $derived(!item ? "" : item.kind === "image" ? item.label : item.kind === "stack" ? item.project : item.name);
</script>

<Modal open={open && item !== null} {title} width="w-[52rem]" showClose {onclose}>
  <div class="flex max-h-[70vh] min-h-0 flex-col" data-testid="docker-item-modal">
    {#if item?.kind === "image"}
      <DockerImageDetail {image} detail={usage} {busy} {refreshSec} {run} {runQuery} {onopen} {onclose} />
    {:else if item?.kind === "network"}
      <DockerNetworkDetail name={item.name} {busy} {refreshSec} {run} {runQuery} {onopen} {onclose} />
    {:else if item?.kind === "volume"}
      <DockerVolumeDetail name={item.name} {usage} {busy} {refreshSec} {run} {runQuery} {onopen} {onclose} />
    {:else if item?.kind === "stack"}
      <DockerStackDetail {stack} active={open} {busy} {refreshSec} {run} {runQuery} {onopen} />
    {/if}
  </div>
</Modal>
