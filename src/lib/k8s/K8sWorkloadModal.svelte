<script lang="ts">
  // A workload's details as a dialog (stage 4) — where the panel has no room to show
  // them beside its list. The content is `K8sWorkloadDetail.svelte`; a wide panel
  // puts that same component into a `SidePane` instead. The dialog stays out of the
  // content: what stands inside a panel's query container owns no `position: fixed`
  // element (`panelcontainer.guard`).
  import type { ComponentProps } from "svelte";
  import Modal from "../ui/Modal.svelte";
  import K8sWorkloadDetail from "./K8sWorkloadDetail.svelte";

  type Props = Omit<ComponentProps<typeof K8sWorkloadDetail>, "active" | "fill"> & {
    open?: boolean;
    onclose: () => void;
  };
  // The view is passed on as a binding: the panel owns it, so it is the same in
  // this dialog and in the pane beside the list.
  let { open = false, tab = $bindable("overview"), onclose, ...rest }: Props = $props();
</script>

<Modal {open} title={rest.workload?.name ?? ""} width="w-[52rem]" showClose {onclose}>
  <K8sWorkloadDetail {...rest} bind:tab active={open} />
</Modal>
