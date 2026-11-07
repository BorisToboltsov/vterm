<script lang="ts">
  // Docker logs / inspect as text (Phase 35). Inspect is fetched once and shown
  // as a monospace, fully selectable block plus a CopyButton for the whole buffer.
  // Logs (v1.33) are read in `LogTail` — follow or hold, filter, severity, tail
  // size; the panel re-polls them while followed and replaces `text`.
  //
  // The content only (v1.7): `DockerTextModal` shows it as a dialog, a wide panel
  // puts it into a `SidePane` beside the list.
  import CopyButton from "../ui/CopyButton.svelte";
  import LogTail from "../ui/LogTail.svelte";
  import type { LogTailSize } from "../ui/loglines";
  import { t } from "../i18n";

  let {
    text = "",
    live = false,
    following = $bindable(true),
    tail = $bindable(200),
    fill = false,
  }: {
    text?: string;
    /** A log (re-polled upstream), not a one-off text. */
    live?: boolean;
    /** The log is followed — re-asked on every poll (bound by the panel). */
    following?: boolean;
    /** How many last lines the panel asks for. */
    tail?: LogTailSize;
    /** Take the height of the place it stands in (a pane beside a list); without
     *  it the text is bounded by the window, as a dialog needs. */
    fill?: boolean;
  } = $props();
</script>

{#if live}
  <LogTail {text} bind:live={following} bind:tail {fill} empty={t("docker.noLogs")} testid="docker" />
{:else}
  <div class="mb-2 flex items-center justify-end gap-2">
    <CopyButton {text} label={t("util.copy")} testid="docker-copy-text" />
  </div>
  <pre
    data-testid="docker-text"
    class="{fill ? 'min-h-0 flex-1' : 'max-h-[64vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
  >{text || t("docker.noLogs")}</pre>
{/if}
