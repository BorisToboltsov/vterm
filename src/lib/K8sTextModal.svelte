<script lang="ts">
  // K8s text (describe / YAML) as a dialog — where the panel has no room to show it beside
  // its list. The content is `K8sText.svelte`; a wide panel puts that same
  // component into a `SidePane` instead (`panelcontainer.guard`).
  import type { ComponentProps } from "svelte";
  import Modal from "./Modal.svelte";
  import K8sText from "./K8sText.svelte";

  type Props = Omit<ComponentProps<typeof K8sText>, "fill"> & {
    open?: boolean;
    title?: string;
    onclose?: () => void;
  };
  let { open = false, title = "", onclose, ...rest }: Props = $props();
</script>

<Modal {open} {title} width="w-[52rem]" showClose {onclose}>
  <K8sText {...rest} />
</Modal>
