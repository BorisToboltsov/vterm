<script lang="ts">
  // "Copy to another session" (v1.12): where in that tab the files land. The
  // folder is prefilled — the one its file panel shows, else its terminal's, else
  // its home — and can be typed over. Copying never moves: the source stays.
  import Modal from "./Modal.svelte";
  import type { CopyTarget } from "./copyto";
  import { typedDir } from "./copyto";
  import { t } from "./i18n";

  let {
    open = false,
    target = null,
    names = [],
    dir = $bindable(""),
    throughApp = false,
    onconfirm,
    oncancel,
  }: {
    open?: boolean;
    /** The tab the files go to. */
    target?: CopyTarget | null;
    /** Names of what is copied. */
    names?: string[];
    /** The destination folder (prefilled by the caller, edited here). */
    dir?: string;
    /** Both sides are servers: the bytes pass through this app, not through its disk. */
    throughApp?: boolean;
    onconfirm?: (dir: string) => void;
    oncancel?: () => void;
  } = $props();

  const dest = $derived(typedDir(dir));
</script>

<Modal
  {open}
  title={t("copyTo.title", { target: target?.title ?? "" })}
  width="w-96"
  onclose={oncancel}
>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      if (dest) onconfirm?.(dest);
    }}
  >
    <div class="mb-2 text-xs text-muted">
      {#if names.length === 1}
        {t("copyTo.one", { name: names[0] })}
      {:else}
        {t("copyTo.many", { count: names.length })}
      {/if}
    </div>
    <input
      data-testid="copy-to-dir"
      class="w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent"
      aria-label={t("copyTo.dir")}
      placeholder={t("copyTo.dir")}
      spellcheck="false"
      autocomplete="off"
      bind:value={dir}
    />
    {#if throughApp}
      <div class="mt-2 text-meta text-muted">{t("copyTo.throughApp")}</div>
    {/if}
    {#if target?.prod}
      <span class="mt-2 block text-meta text-danger">{t("git.confirmProdWarn")}</span>
    {/if}
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        onclick={() => oncancel?.()}
      >
        {t("common.cancel")}
      </button>
      <button
        type="submit"
        data-testid="copy-to-confirm"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40"
        disabled={!dest}
      >
        {t("copyTo.confirm")}
      </button>
    </div>
  </form>
</Modal>
