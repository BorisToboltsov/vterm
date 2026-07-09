<script lang="ts">
  // Broadcast command line (Phase 22): compose one command and send it to every
  // selected server at once. The bar is presentational — it emits `onsend(cmd)`
  // and the page does the eligibility/prod gating and the actual fan-out writes.
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";

  let {
    targetCount,
    disabled = false,
    prodWarn = false,
    onsend,
  }: {
    /** How many live sessions the command would reach. */
    targetCount: number;
    /** No live targets → input and button are inert. */
    disabled?: boolean;
    /** Group includes a prod server → show the amber caution line. */
    prodWarn?: boolean;
    onsend: (cmd: string) => void;
  } = $props();

  let value = $state("");
  let inputEl = $state<HTMLInputElement>();

  function send() {
    if (disabled || value.length === 0) return;
    onsend(value);
    value = "";
    inputEl?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="shrink-0 border-t border-edge bg-panel-alt px-2 py-1.5">
  {#if prodWarn}
    <div class="mb-1 flex items-center gap-1.5 text-[11px] text-yellow-500">
      <Icon name="shield" size={13} />
      {t("broadcast.prodWarn")}
    </div>
  {/if}
  <div class="flex items-center gap-2">
    <Icon name="broadcast" size={16} class="shrink-0 text-accent" />
    <span class="shrink-0 whitespace-nowrap text-xs text-muted">
      {t("broadcast.targetCount", { count: targetCount })}
    </span>
    <input
      bind:this={inputEl}
      bind:value
      data-testid="broadcast-input"
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-label={t("broadcast.placeholder")}
      placeholder={t("broadcast.placeholder")}
      class="min-w-0 flex-1 rounded border border-edge bg-panel px-2.5 py-1.5 font-mono text-sm text-white placeholder:text-muted focus:border-accent focus:outline-none"
      onkeydown={onKey}
    />
    <button
      data-testid="broadcast-send"
      class="flex shrink-0 items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm text-panel-alt hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
      onclick={send}
      disabled={disabled || value.length === 0}
    >
      <Icon name="send" size={14} />
      {t("broadcast.send")}
    </button>
  </div>
</div>
