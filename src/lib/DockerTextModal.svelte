<script lang="ts">
  // Text modal for Docker logs / inspect (Phase 35). A wide, monospace, fully
  // selectable pane (native Cmd/Ctrl+C works) plus a CopyButton that grabs the
  // whole buffer. Built on the shared Modal primitive for consistency with the
  // git diff modal. Logs re-poll upstream (the panel replaces `text`); inspect is
  // fetched once — either way this component just renders the current `text`.
  import Modal from "./Modal.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { t } from "./i18n";

  let {
    open = false,
    title = "",
    text = "",
    live = false,
    onclose,
  }: {
    open?: boolean;
    title?: string;
    text?: string;
    /** Logs view: show a subtle "live" hint (the panel keeps re-polling). */
    live?: boolean;
    onclose?: () => void;
  } = $props();
</script>

<Modal {open} {title} width="w-[52rem]" showClose {onclose}>
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
    class="max-h-[64vh] overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-white/85 select-text"
  >{text || t("docker.noLogs")}</pre>
</Modal>

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
