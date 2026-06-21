<script lang="ts">
  // Confirmation dialog built on Modal: a title, a message (children), and
  // Cancel / Confirm buttons. Defaults to a destructive (danger) confirm.
  import type { Snippet } from "svelte";
  import Modal from "./Modal.svelte";

  let {
    open = false,
    title,
    confirmLabel = "Delete",
    danger = true,
    onconfirm,
    oncancel,
    children,
  }: {
    open?: boolean;
    title: string;
    confirmLabel?: string;
    /** Style the confirm button as destructive. */
    danger?: boolean;
    onconfirm?: () => void;
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
      class="rounded px-3 py-1 text-sm text-muted hover:text-white"
      onclick={() => oncancel?.()}
    >
      Cancel
    </button>
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
