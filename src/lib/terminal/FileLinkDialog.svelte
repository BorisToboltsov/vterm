<script lang="ts">
  // The question a click on a file named in terminal output asks (v1.24, ADR
  // 0035). Opening shows where the file is — the server, or this computer —
  // and its whole path: the name was placed in the folder the command ran in,
  // and the path is what tells whether that is the file meant. A production
  // server says so in red: the file is edited there. A name nobody could place
  // (an SSH shell that does not report its folder) asks about path sync
  // instead, which is what would let such names open.
  import Modal from "../ui/Modal.svelte";
  import type { FileLinkQuestion } from "./termfiles";
  import { t } from "../i18n";

  let {
    ask,
    onanswer,
  }: {
    ask: FileLinkQuestion | null;
    onanswer: (answer: "open" | "sync" | "cancel", silence: boolean) => void;
  } = $props();

  let silence = $state(false);

  // Each question starts unticked: an earlier "don't ask" left unanswered must
  // not carry over to another file.
  $effect(() => {
    if (ask) silence = false;
  });

  const title = $derived(
    !ask
      ? ""
      : ask.kind === "sync"
        ? t("filelink.syncTitle")
        : ask.target.kind === "dir"
          ? t("filelink.titleDir")
          : t("filelink.titleFile"),
  );
</script>

<Modal open={!!ask} {title} titleClass="text-accent" width="w-[32rem]" onclose={() => onanswer("cancel", false)}>
  {#if ask?.kind === "open"}
    {#if ask.prod}
      <p
        class="mb-3 rounded border border-bad/50 bg-bad/10 px-2.5 py-2 text-xs text-bad"
        data-testid="filelink-prod"
      >
        {t("filelink.prod")}
      </p>
    {/if}
    <div class="mb-1 text-caption uppercase tracking-wider text-muted">{t("filelink.where")}</div>
    <p class="break-all text-sm font-medium text-text" data-testid="filelink-where">
      {ask.where ?? t("filelink.thisComputer")}
    </p>
    <div class="mb-1 mt-3 text-caption uppercase tracking-wider text-muted">{t("filelink.path")}</div>
    <p
      class="max-h-32 overflow-auto break-all rounded border border-edge bg-panel p-2 font-mono text-xs text-text"
      data-testid="filelink-path"
    >{ask.target.path}</p>
    <p class="mt-2 text-xs text-muted" data-testid="filelink-hint">
      {ask.target.kind === "dir"
        ? t("filelink.dirHint")
        : ask.target.line
          ? t("filelink.fileLineHint", { line: ask.target.line })
          : t("filelink.fileHint")}
    </p>

    <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
      <label class="mr-auto flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" bind:checked={silence} data-testid="filelink-silence" />
        {t("link.dontAsk")}
      </label>
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        onclick={() => onanswer("cancel", false)}
      >
        {t("common.cancel")}
      </button>
      <button
        type="button"
        data-testid="filelink-open"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover hover:opacity-90"
        onclick={() => onanswer("open", silence)}
      >
        {t("link.open")}
      </button>
    </div>
  {:else if ask?.kind === "sync"}
    <p class="text-sm text-text" data-testid="filelink-sync-body">
      {ask.following ? t("filelink.syncOnBody") : t("filelink.syncBody")}
    </p>
    <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        onclick={() => onanswer("cancel", false)}
      >
        {ask.following ? t("common.close") : t("common.cancel")}
      </button>
      {#if !ask.following}
        <button
          type="button"
          data-testid="filelink-sync"
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover hover:opacity-90"
          onclick={() => onanswer("sync", false)}
        >
          {t("filelink.syncEnable")}
        </button>
      {/if}
    </div>
  {/if}
</Modal>
