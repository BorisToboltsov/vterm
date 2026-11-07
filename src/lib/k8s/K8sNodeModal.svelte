<script lang="ts">
  // A node's details as a dialog (stage 5) — where the panel has no room to show
  // them beside its list. The content is `K8sNodeDetail.svelte`; a wide panel puts
  // that same component into a `SidePane` instead. The dialog stays out of the
  // content: what stands inside a panel's query container owns no `position: fixed`
  // element (`panelcontainer.guard`).
  import type { ComponentProps } from "svelte";
  import Modal from "../ui/Modal.svelte";
  import K8sNodeDetail from "./K8sNodeDetail.svelte";

  type Props = Omit<ComponentProps<typeof K8sNodeDetail>, "active" | "fill"> & {
    open?: boolean;
    onclose: () => void;
  };
  // The view is passed on as a binding: the panel owns it.
  let { open = false, tab = $bindable("overview"), onclose, ...rest }: Props = $props();
</script>

<Modal {open} title={rest.node?.name ?? ""} width="w-[52rem]" showClose {onclose}>
  <K8sNodeDetail {...rest} bind:tab active={open} />
</Modal>
