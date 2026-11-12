<script lang="ts">
  // "Paste into all" of synchronous input (ADR 0064): a block of text goes into
  // every member's terminal as a paste — through each terminal's own paste, so
  // it is bracketed wherever the program there asked for it: a shell shows it at
  // the prompt rather than running it line by line, vim and nano insert it as
  // text without stairs of auto-indent. Nothing in it is followed by Enter.
  import Modal from "../ui/Modal.svelte";
  import Icon from "../ui/Icon.svelte";
  import { t } from "../i18n";

  let {
    open = false,
    text = "",
    targets = [],
    prod = [],
    onpaste,
    oncancel,
  }: {
    open?: boolean;
    /** What it opens with (a block pasted into the line), or empty. */
    text?: string;
    /** Labels of the members that get it. */
    targets?: string[];
    /** Labels of the prod servers among them. */
    prod?: string[];
    onpaste?: (text: string) => void;
    oncancel?: () => void;
  } = $props();

  let draft = $state("");
  let area = $state<HTMLTextAreaElement>();

  $effect(() => {
    if (!open) return;
    draft = text;
    queueMicrotask(() => area?.focus());
  });
</script>

<Modal {open} title={t("groupPaste.title")} width="w-[36rem]" onclose={oncancel}>
  <p class="mb-2 text-xs leading-relaxed text-muted">{t("groupPaste.hint")}</p>
  <textarea
    bind:this={area}
    bind:value={draft}
    data-testid="group-paste-text"
    spellcheck="false"
    rows="8"
    aria-label={t("groupPaste.title")}
    class="w-full resize-y rounded border border-edge bg-panel p-2 font-mono text-xs leading-relaxed text-text focus:border-accent focus:outline-none"
  ></textarea>
  <p class="mt-2 text-meta text-muted" data-testid="group-paste-targets">
    {t("groupPaste.targets", { count: targets.length, names: targets.join(", ") })}
  </p>
  {#if prod.length > 0}
    <p data-testid="group-paste-prod" class="mt-2 flex items-center gap-1.5 rounded border border-bad/50 bg-bad/10 px-2.5 py-1.5 text-xs text-bad">
      <Icon name="shield" size={13} />
      {t("groupPaste.prod", { names: prod.join(", ") })}
    </p>
  {/if}
  <div class="mt-4 flex justify-end gap-2">
    <button type="button" class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={() => oncancel?.()}>
      {t("common.cancel")}
    </button>
    <button
      type="button"
      data-testid="group-paste-confirm"
      disabled={draft.length === 0 || targets.length === 0}
      class="rounded px-3 py-1 text-sm text-panel-alt disabled:cursor-not-allowed disabled:opacity-40 {prod.length > 0
        ? 'bg-danger hover:opacity-90'
        : 'bg-accent hover:bg-accent-hover'}"
      onclick={() => onpaste?.(draft)}
    >
      {t("groupPaste.confirm", { count: targets.length })}
    </button>
  </div>
</Modal>
