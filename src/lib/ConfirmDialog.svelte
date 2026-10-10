<script lang="ts">
  // Confirmation dialog built on Modal: a title, a message (children), and
  // Cancel / Confirm buttons. Defaults to a destructive (danger) confirm.
  // An optional third answer (`altLabel` + `onalt`) stands between the two — the
  // safe way through, e.g. "skip the files that are already there".
  import type { Snippet } from "svelte";
  import Modal from "./Modal.svelte";
  import { t } from "./i18n";

  let {
    open = false,
    title,
    confirmLabel = "Delete",
    danger = true,
    altLabel,
    onconfirm,
    onalt,
    oncancel,
    children,
  }: {
    open?: boolean;
    title: string;
    confirmLabel?: string;
    /** Style the confirm button as destructive. */
    danger?: boolean;
    /** Label of the optional middle answer; none without it. */
    altLabel?: string;
    onconfirm?: () => void;
    onalt?: () => void;
    oncancel?: () => void;
    children?: Snippet;
  } = $props();
</script>

<Modal {open} {title} titleClass={danger ? "text-danger" : "text-accent"} onclose={oncancel}>
  <div class="mb-4 text-xs text-muted">
    {@render children?.()}
  </div>
  <div class="flex justify-end gap-2">
    <button
      type="button"
      class="rounded px-3 py-1 text-sm text-muted hover:text-text"
      onclick={() => oncancel?.()}
    >
      {t("common.cancel")}
    </button>
    {#if altLabel}
      <button
        type="button"
        data-testid="confirm-alt"
        class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
        onclick={() => onalt?.()}
      >
        {altLabel}
      </button>
    {/if}
    <button
      type="button"
      data-testid="confirm"
      class="rounded px-3 py-1 text-sm text-panel-alt hover:opacity-90 {danger
        ? 'bg-danger'
        : 'bg-accent hover:bg-accent-hover'}"
      onclick={() => onconfirm?.()}
    >
      {confirmLabel}
    </button>
  </div>
</Modal>
