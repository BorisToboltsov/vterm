<script lang="ts">
  // Docker container details as a dialog — where the panel has no room to show them
  // beside its list. The content is `DockerDetail.svelte`; a wide panel puts that
  // same component into a `SidePane` instead. The dialog is kept out of the
  // content on purpose: what stands inside a panel's query container must own
  // no `position: fixed` element (`panelcontainer.guard`).
  import type { ComponentProps } from "svelte";
  import Modal from "../ui/Modal.svelte";
  import DockerDetail from "./DockerDetail.svelte";

  type Props = Omit<ComponentProps<typeof DockerDetail>, "active" | "fill" | "closeOnAsk"> & {
    open?: boolean;
  };
  // `tab` is passed on as a binding, not spread with the rest: the panel owns the
  // view, so that it is the same in this dialog and in the pane beside the list.
  let { open = false, tab = $bindable("overview"), ...rest }: Props = $props();
</script>

<Modal {open} title={rest.container?.name ?? ""} width="w-[52rem]" showClose onclose={rest.onclose}>
  <DockerDetail {...rest} bind:tab active={open} closeOnAsk />
</Modal>
