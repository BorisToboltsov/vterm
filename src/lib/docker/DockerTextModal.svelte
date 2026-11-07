<script lang="ts">
  // Docker text (logs / inspect) as a dialog — where the panel has no room to show it beside
  // its list. The content is `DockerText.svelte`; a wide panel puts that same
  // component into a `SidePane` instead (`panelcontainer.guard`).
  import type { ComponentProps } from "svelte";
  import Modal from "../ui/Modal.svelte";
  import DockerText from "./DockerText.svelte";

  type Props = Omit<ComponentProps<typeof DockerText>, "fill"> & {
    open?: boolean;
    title?: string;
    onclose?: () => void;
  };
  // The log's follow switch and tail size are the panel's (it asks for the log),
  // so they pass through as bindings, not with the rest.
  let { open = false, title = "", onclose, following = $bindable(true), tail = $bindable(200), ...rest }: Props = $props();
</script>

<Modal {open} {title} width="w-[52rem]" showClose {onclose}>
  <DockerText {...rest} bind:following bind:tail />
</Modal>
