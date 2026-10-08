<script lang="ts">
  // Kubernetes describe / YAML as text (Phase 37): a monospace, fully selectable
  // block (native Cmd/Ctrl+C works) plus a CopyButton for the whole buffer. The
  // panel fetches the text (once — these are read-only), this just renders it.
  // Mirrors DockerText.
  //
  // The content only (v1.7): `K8sTextModal` shows it as a dialog, a wide panel
  // puts it into a `SidePane` beside the list.
  import CopyButton from "./CopyButton.svelte";
  import { t } from "./i18n";

  let {
    text = "",
    fill = false,
  }: {
    text?: string;
    /** Take the height of the place it stands in (a pane beside a list); without
     *  it the text is bounded by the window, as a dialog needs. */
    fill?: boolean;
  } = $props();
</script>

<div class="mb-2 flex justify-end">
  <CopyButton {text} label={t("util.copy")} testid="k8s-copy-text" />
</div>
<pre
  data-testid="k8s-text"
  class="{fill ? 'min-h-0 flex-1' : 'max-h-[64vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
>{text || t("k8s.noLogs")}</pre>
