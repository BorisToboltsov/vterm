<script lang="ts">
  // Title + description editor for a recording, built on Modal. Used in two places:
  //  • right after stopping a recording — with a Delete button to discard it;
  //  • from the library's pencil button — to edit an existing recording's metadata.
  // The parent owns the API calls; this just collects the fields.
  import Modal from "./Modal.svelte";
  import { t } from "./i18n";

  let {
    open = false,
    heading,
    defaultTitle = "",
    defaultDescription = "",
    onsave,
    ondelete,
    onclose,
  }: {
    open?: boolean;
    heading: string;
    defaultTitle?: string;
    defaultDescription?: string;
    onsave?: (title: string, description: string) => void;
    /** When provided, a destructive Delete button is shown (post-stop flow). */
    ondelete?: () => void;
    onclose?: () => void;
  } = $props();

  let title = $state("");
  let description = $state("");

  // Reset/prefill each time the dialog opens.
  $effect(() => {
    if (open) {
      title = defaultTitle;
      description = defaultDescription;
    }
  });

  const inputClass =
    "w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent";
</script>

<Modal {open} title={heading} {onclose}>
  <div class="flex flex-col gap-3">
    <label class="flex flex-col gap-1 text-xs text-muted">
      {t("recordings.titleField")}
      <input
        bind:value={title}
        type="text"
        spellcheck="false"
        placeholder={t("recordings.titlePlaceholder")}
        class={inputClass}
      />
    </label>
    <label class="flex flex-col gap-1 text-xs text-muted">
      {t("recordings.descField")}
      <textarea
        bind:value={description}
        rows="3"
        placeholder={t("recordings.descPlaceholder")}
        class="{inputClass} resize-none"
      ></textarea>
    </label>
    <div class="mt-1 flex items-center justify-between gap-2">
      <div>
        {#if ondelete}
          <button
            type="button"
            onclick={() => ondelete?.()}
            class="rounded bg-danger px-3 py-1 text-sm font-medium text-panel-alt hover:opacity-90"
          >
            {t("common.delete")}
          </button>
        {/if}
      </div>
      <div class="flex gap-2">
        {#if !ondelete}
          <button
            type="button"
            onclick={() => onclose?.()}
            class="rounded px-3 py-1 text-sm text-muted hover:text-text"
          >
            {t("common.cancel")}
          </button>
        {/if}
        <button
          type="button"
          onclick={() => onsave?.(title.trim(), description.trim())}
          class="rounded bg-accent px-3 py-1 text-sm font-medium text-panel-alt hover:bg-accent-hover"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  </div>
</Modal>
