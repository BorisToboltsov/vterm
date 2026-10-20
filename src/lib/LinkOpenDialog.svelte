<script lang="ts">
  // The one "open this link?" question of a window (v1.20), for links clicked in
  // terminal output (`stores/linkopen`). It shows the host the browser will
  // connect to — punycode for a non-Latin name — and the whole address with the
  // host standing out, so a trusted name put in the user part or a lookalike
  // letter is in plain sight. A link whose text names another site says so, and
  // asks without offering "don't ask again". An http link is offered for copying
  // only: the opener's capability lets the app open https and nothing else.
  import Modal from "./Modal.svelte";
  import { addressParts } from "./termlink";
  import { answerLink, currentLinkQuestion } from "./stores/linkopen.svelte";
  import { t } from "./i18n";

  const ask = $derived(currentLinkQuestion());
  const parts = $derived(ask ? addressParts(ask.target) : null);
  let silence = $state(false);

  // Each question starts unticked: an earlier "don't ask" left unanswered must
  // not carry over to another link.
  $effect(() => {
    if (ask) silence = false;
  });
</script>

<Modal
  open={!!ask}
  title={ask?.shown
    ? t("link.misleadTitle")
    : ask && !ask.target.openable
      ? t("link.copyTitle")
      : t("link.title")}
  titleClass={ask?.shown ? "text-danger" : "text-accent"}
  width="w-[32rem]"
  onclose={() => answerLink("cancel")}
>
  {#if ask && parts}
    {#if ask.shown}
      <p
        class="mb-3 rounded border border-bad/50 bg-bad/10 px-2.5 py-2 text-xs text-bad"
        data-testid="link-mislead"
      >
        {t("link.mislead", { shown: ask.shown, host: ask.target.host })}
      </p>
    {/if}
    <div class="mb-1 text-caption uppercase tracking-wider text-muted">{t("link.site")}</div>
    <p class="break-all text-sm font-medium text-text" data-testid="link-host">{ask.target.host}</p>
    {#if ask.target.idn}
      <p class="mt-1 text-xs text-warn" data-testid="link-idn">{t("link.idn")}</p>
    {/if}
    {#if !ask.target.openable}
      <p class="mt-1 text-xs text-warn" data-testid="link-http">{t("link.httpOnlyCopy")}</p>
    {/if}
    <div class="mb-1 mt-3 text-caption uppercase tracking-wider text-muted">{t("link.address")}</div>
    <p
      class="max-h-32 overflow-auto break-all rounded border border-edge bg-panel p-2 font-mono text-xs text-muted"
      data-testid="link-address"
    >{parts.before}<span class="text-text">{parts.host}</span>{parts.after}</p>

    <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
      {#if ask.canSilence}
        <label class="mr-auto flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" bind:checked={silence} data-testid="link-silence" />
          {t("link.dontAsk")}
        </label>
      {/if}
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        onclick={() => answerLink("cancel")}
      >
        {t("common.cancel")}
      </button>
      <button
        type="button"
        data-testid="link-copy"
        class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
        onclick={() => answerLink("copy")}
      >
        {t("link.copy")}
      </button>
      {#if ask.target.openable}
        <button
          type="button"
          data-testid="link-open"
          class="rounded px-3 py-1 text-sm text-panel-alt hover:opacity-90 {ask.shown
            ? 'bg-danger'
            : 'bg-accent hover:bg-accent-hover'}"
          onclick={() => answerLink("open", silence)}
        >
          {t("link.open")}
        </button>
      {/if}
    </div>
  {/if}
</Modal>
