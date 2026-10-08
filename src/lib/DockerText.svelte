<script lang="ts">
  // Docker logs / inspect as text (Phase 35): a monospace, fully selectable block
  // (native Cmd/Ctrl+C works) plus a CopyButton that grabs the whole buffer. Logs
  // re-poll upstream (the panel replaces `text`); inspect is fetched once — either
  // way this component just renders the current `text`.
  //
  // The content only (v1.7): `DockerTextModal` shows it as a dialog, a wide panel
  // puts it into a `SidePane` beside the list.
  import CopyButton from "./CopyButton.svelte";
  import { t } from "./i18n";

  let {
    text = "",
    live = false,
    fill = false,
  }: {
    text?: string;
    /** Logs view: show a subtle "live" hint (the panel keeps re-polling). */
    live?: boolean;
    /** Take the height of the place it stands in (a pane beside a list); without
     *  it the text is bounded by the window, as a dialog needs. */
    fill?: boolean;
  } = $props();
</script>

<div class="mb-2 flex items-center justify-between gap-2">
  {#if live}
    <span class="flex items-center gap-1.5 text-meta text-muted">
      <span class="dk-pulse inline-block h-1.5 w-1.5 rounded-full bg-ok"></span>
      {t("docker.viewLogs")}
    </span>
  {:else}
    <span></span>
  {/if}
  <CopyButton {text} label={t("util.copy")} testid="docker-copy-text" />
</div>
<pre
  data-testid="docker-text"
  class="{fill ? 'min-h-0 flex-1' : 'max-h-[64vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
>{text || t("docker.noLogs")}</pre>

<style>
  .dk-pulse {
    animation: dk-pulse-kf 1.4s ease-in-out infinite;
  }
  @keyframes dk-pulse-kf {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dk-pulse {
      animation: none;
    }
  }
</style>
