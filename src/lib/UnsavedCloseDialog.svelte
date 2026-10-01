<script lang="ts">
  // Closing an edited file: Save / Don't save / Cancel — the three answers every
  // editor gives. A two-button "Cancel / Discard" left saving as a detour (cancel,
  // ⌘S, close again) and read as if the file itself would be deleted.
  import Modal from "./Modal.svelte";
  import { t } from "./i18n";

  let {
    open = false,
    name,
    canSave = true,
    onsave,
    ondiscard,
    oncancel,
  }: {
    open?: boolean;
    name: string;
    /** False for a read-only doc: only "don't save" and "cancel" make sense. */
    canSave?: boolean;
    onsave?: () => void;
    ondiscard?: () => void;
    oncancel?: () => void;
  } = $props();
</script>

<Modal {open} title={t("editor.discardTitle", { name })} titleClass="text-accent" onclose={oncancel}>
  <div class="mb-4 text-xs text-muted">{t("editor.discardBody")}</div>
  <div class="flex justify-end gap-2">
    <button
      type="button"
      data-testid="unsaved-cancel"
      class="rounded px-3 py-1 text-sm text-muted hover:text-text"
      onclick={() => oncancel?.()}
    >
      {t("common.cancel")}
    </button>
    <button
      type="button"
      data-testid="unsaved-discard"
      class="rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger hover:text-panel-alt"
      onclick={() => ondiscard?.()}
    >
      {t("editor.discard")}
    </button>
    {#if canSave}
      <button
        type="button"
        data-testid="unsaved-save"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
        onclick={() => onsave?.()}
      >
        {t("common.save")}
      </button>
    {/if}
  </div>
</Modal>
