<script lang="ts">
  import Modal from "../ui/Modal.svelte";
  import { t } from "../i18n";
  import {
    hasPasteStructureRisk,
    transformTerminalPaste,
    type TerminalPasteMode,
  } from "./termpaste";

  let {
    open = false,
    text = "",
    continuation = true,
    onpaste,
    oncancel,
  }: {
    open?: boolean;
    text?: string;
    /** Backslash continuation is a POSIX-shell operation. */
    continuation?: boolean;
    onpaste?: (text: string) => void;
    oncancel?: () => void;
  } = $props();

  let mode = $state<TerminalPasteMode>("exact");
  const preview = $derived(transformTerminalPaste(text, mode));
  const risky = $derived(hasPasteStructureRisk(text));

  // Every newly-opened paste starts from the lossless option, including when a
  // previous dialog used a transformation.
  $effect(() => {
    if (open) mode = "exact";
  });
</script>

<Modal {open} title={t("paste.multiTitle")} width="w-[36rem]" onclose={oncancel}>
  <p class="mb-3 text-xs leading-relaxed text-muted">{t("paste.multiHint")}</p>

  <div class="space-y-2" role="radiogroup" aria-label={t("paste.multiMode")}>
    <label class="flex cursor-pointer items-start gap-2 rounded border border-edge px-2.5 py-2 hover:bg-edge/30">
      <input type="radio" bind:group={mode} value="exact" />
      <span>
        <span class="block text-sm text-text">{t("paste.exact")}</span>
        <span class="block text-caption text-muted">{t("paste.exactHint")}</span>
      </span>
    </label>
    <label class="flex cursor-pointer items-start gap-2 rounded border border-edge px-2.5 py-2 hover:bg-edge/30">
      <input type="radio" bind:group={mode} value="single" />
      <span>
        <span class="block text-sm text-text">{t("paste.single")}</span>
        <span class="block text-caption text-muted">{t("paste.singleHint")}</span>
      </span>
    </label>
    {#if continuation}
      <label class="flex cursor-pointer items-start gap-2 rounded border border-edge px-2.5 py-2 hover:bg-edge/30">
        <input type="radio" bind:group={mode} value="continued" />
        <span>
          <span class="block text-sm text-text">{t("paste.continued")}</span>
          <span class="block text-caption text-muted">{t("paste.continuedHint")}</span>
        </span>
      </label>
    {/if}
  </div>

  {#if risky && mode !== "exact"}
    <p class="mt-3 rounded border border-warn/50 bg-warn/10 px-2.5 py-2 text-xs text-warn" data-testid="paste-risk">
      {t("paste.structureWarn")}
    </p>
  {/if}

  <div class="mt-3">
    <div class="mb-1 text-caption uppercase tracking-wider text-muted">{t("paste.preview")}</div>
    <pre class="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-edge bg-panel p-2 font-mono text-xs leading-relaxed text-text" data-testid="paste-preview">{preview}</pre>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={() => oncancel?.()}>
      {t("common.cancel")}
    </button>
    <button
      type="button"
      class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
      onclick={() => onpaste?.(preview)}
    >
      {t("paste.confirm")}
    </button>
  </div>
</Modal>
