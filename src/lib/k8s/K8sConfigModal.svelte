<script lang="ts">
  // A ConfigMap's or a Secret's details as a dialog (v1.36, ADR 0061) — where the
  // panel has no room to show them beside its list. The content is
  // `K8sConfigDetail.svelte`; a wide panel puts that same component into a
  // `SidePane` instead. The dialog stays out of the content: what stands inside a
  // panel's query container owns no `position: fixed` element (`panelcontainer.guard`).
  import Modal from "../ui/Modal.svelte";
  import K8sConfigDetail from "./K8sConfigDetail.svelte";
  import type { K8sConfig } from "./k8s";

  let { open = false, config = null, onclose }: { open?: boolean; config?: K8sConfig | null; onclose: () => void } = $props();
</script>

<Modal {open} title={config?.name ?? ""} width="w-[40rem]" showClose {onclose}>
  <K8sConfigDetail {config} />
</Modal>
