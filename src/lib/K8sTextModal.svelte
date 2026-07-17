<script lang="ts">
  // Text modal for Kubernetes describe / YAML (Phase 37) — a wide, monospace,
  // fully selectable pane (native Cmd/Ctrl+C works) plus a CopyButton for the
  // whole buffer. Mirrors DockerTextModal; the panel fetches the text (once for
  // describe/yaml — these are read-only), this just renders it.
  import Modal from "./Modal.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { t } from "./i18n";

  let {
    open = false,
    title = "",
    text = "",
    onclose,
  }: {
    open?: boolean;
    title?: string;
    text?: string;
    onclose?: () => void;
  } = $props();
</script>

<Modal {open} {title} width="w-[52rem]" showClose {onclose}>
  <div class="mb-2 flex justify-end">
    <CopyButton {text} label={t("util.copy")} testid="k8s-copy-text" />
  </div>
  <pre
    data-testid="k8s-text"
    class="max-h-[64vh] overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed text-white/85 select-text"
  >{text || t("k8s.noLogs")}</pre>
</Modal>
