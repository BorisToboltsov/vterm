<script lang="ts">
  // K8s pod details as a dialog — where the panel has no room to show them
  // beside its list. The content is `K8sDetail.svelte`; a wide panel puts that
  // same component into a `SidePane` instead. The dialog is kept out of the
  // content on purpose: what stands inside a panel's query container must own
  // no `position: fixed` element (`panelcontainer.guard`).
  import type { ComponentProps } from "svelte";
  import Modal from "./Modal.svelte";
  import K8sDetail from "./K8sDetail.svelte";

  type Props = Omit<ComponentProps<typeof K8sDetail>, "active" | "fill" | "closeOnAsk"> & {
    open?: boolean;
  };
  let { open = false, ...rest }: Props = $props();
</script>

<Modal {open} title={rest.pod?.name ?? ""} width="w-[52rem]" showClose onclose={rest.onclose}>
  <K8sDetail {...rest} active={open} closeOnAsk />
</Modal>
