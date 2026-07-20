<script lang="ts">
  // Privacy consent before any session context leaves the machine (Phase 17.3).
  // Shows exactly what will be sent — already redacted — plus the destination
  // endpoint and a "N lines" figure, and requires an explicit confirm. Applies
  // to local endpoints too: sending to Ollama on localhost is still a send.
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";
  import type { BuiltContext } from "./aicontext";

  let {
    open = false,
    context,
    endpointName,
    endpointUrl,
    onconfirm,
    oncancel,
  }: {
    open?: boolean;
    context: BuiltContext;
    endpointName: string;
    endpointUrl: string;
    onconfirm?: () => void;
    oncancel?: () => void;
  } = $props();
</script>

<Modal
  {open}
  title={t("ai.consent.title")}
  width="w-[34rem]"
  onclose={oncancel}
>
  <div class="space-y-3 text-xs" data-testid="ai-consent">
    <p class="text-muted">
      {t("ai.consent.summary", {
        lines: String(context.lines),
        name: endpointName,
      })}
    </p>
    <p class="break-all text-meta text-muted">
      <span class="opacity-70">{endpointUrl}</span>
    </p>
    {#if context.redactions > 0}
      <p class="flex items-center gap-1 text-meta text-accent">
        <Icon name="lock" size={12} />
        {t("ai.consent.redacted", { count: String(context.redactions) })}
      </p>
    {/if}
    <pre
      data-testid="ai-consent-preview"
      class="max-h-72 overflow-auto rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed whitespace-pre-wrap break-words text-white">{context.text}</pre>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <button
      type="button"
      class="rounded px-3 py-1 text-sm text-muted hover:text-white"
      onclick={() => oncancel?.()}
    >
      {t("common.cancel")}
    </button>
    <button
      type="button"
      data-testid="ai-consent-confirm"
      class="flex items-center gap-1 rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
      onclick={() => onconfirm?.()}
    >
      <Icon name="arrowRight" size={13} />
      {t("ai.consent.send")}
    </button>
  </div>
</Modal>
