<script lang="ts" module>
  /** What the question is about: one session, on the server (or computer) it runs on. */
  export interface PathSyncAsk {
    sessionId: string;
    kind: "ssh" | "local";
    /** The server's name; null for a local tab — it is "this computer". */
    target: string | null;
    prod: boolean;
    /** Whether this session's shell needs the setup command typed now. */
    needsSetup: boolean;
  }
</script>

<script lang="ts">
  // The question asked when path sync is turned on where it has no answer yet
  // (v1.23): this time only, every time on this server, or by hand without the
  // question. Three outcomes, one button — two checkboxes would offer a fourth
  // combination that means nothing. A lasting answer is saved by the caller (the
  // server's profile, or settings for a local tab); this only asks. The setup
  // command is shown whenever the answer lets the app type it unasked later.
  import Modal from "../ui/Modal.svelte";
  import { osc7SetupDisplay } from "./shellintegration";
  import { segmentStep } from "../ui/segmented";
  import {
    PATH_SYNC_CHOICES,
    choiceMode,
    questionShowsSetup,
    warnsProd,
    type PathSyncChoice,
  } from "./pathsync";
  import { t } from "../i18n";

  let {
    ask,
    onanswer,
    oncancel,
  }: {
    ask: PathSyncAsk | null;
    onanswer: (choice: PathSyncChoice) => void;
    oncancel: () => void;
  } = $props();

  let choice = $state<PathSyncChoice>("once");
  let buttons: HTMLButtonElement[] = $state([]);

  // Each question starts at "only now": a lasting answer is a choice, not a default.
  $effect(() => {
    if (ask) choice = "once";
  });

  const showsSetup = $derived(ask ? questionShowsSetup(ask.kind, ask.needsSetup, choice) : false);
  const body = $derived(
    !ask || ask.kind === "local"
      ? t("pathSync.bodyFollow")
      : ask.needsSetup
        ? t("pathSync.bodySetupNow")
        : showsSetup
          ? t("pathSync.bodySetupLater")
          : t("pathSync.bodyFollow"),
  );

  const TITLE = {
    always: "pathSync.choiceAlways",
    once: "pathSync.choiceOnce",
    manual: "pathSync.choiceManual",
  } as const;
  const HINT = {
    always: "pathSync.choiceAlwaysHint",
    once: "pathSync.choiceOnceHint",
    manual: "pathSync.choiceManualHint",
  } as const;

  function onkeydown(e: KeyboardEvent, i: number) {
    const next = segmentStep(e.key, i, PATH_SYNC_CHOICES.length);
    if (next == null) return;
    e.preventDefault();
    choice = PATH_SYNC_CHOICES[next];
    buttons[next]?.focus();
  }
</script>

<Modal
  open={!!ask}
  title={t("sftp.followSetupTitle")}
  titleClass="text-accent"
  width="w-[30rem]"
  onclose={oncancel}
>
  {#if ask}
    <div class="text-xs text-muted">
      <p class="mb-2">{body}</p>
      {#if showsSetup}
        <pre
          class="overflow-x-auto rounded border border-edge bg-panel p-2 text-meta leading-relaxed text-muted"
          data-testid="path-sync-setup">{osc7SetupDisplay()}</pre>
        {#if choice === "always"}
          <p class="mt-1">{t("pathSync.setupAlways")}</p>
        {:else if choice === "manual"}
          <p class="mt-1">{t("pathSync.setupManual")}</p>
        {/if}
      {/if}
      <div
        role="radiogroup"
        aria-label={t("pathSync.choices")}
        class="mt-3 grid gap-1.5"
        data-testid="path-sync-choices"
      >
        {#each PATH_SYNC_CHOICES as c, i (c)}
          <button
            bind:this={buttons[i]}
            type="button"
            role="radio"
            aria-checked={choice === c}
            tabindex={choice === c ? 0 : -1}
            data-testid="path-sync-{c}"
            class="flex items-start gap-2 rounded border px-2 py-1.5 text-left {choice === c
              ? 'border-accent bg-accent/15'
              : 'border-edge bg-panel hover:bg-edge'}"
            onclick={() => (choice = c)}
            onkeydown={(e) => onkeydown(e, i)}
          >
            <span
              class="mt-0.5 h-3 w-3 shrink-0 rounded-full {choice === c
                ? 'border-4 border-accent'
                : 'border border-muted'}"
              aria-hidden="true"
            ></span>
            <span class="min-w-0">
              <span class="block {choice === c ? 'text-accent' : 'text-text'}"
                >{t(TITLE[c], { target: ask.target ?? t("pathSync.thisComputer") })}</span
              >
              <span class="block text-meta text-muted">{t(HINT[c])}</span>
            </span>
          </button>
        {/each}
      </div>
      {#if warnsProd(ask.kind, ask.prod, choiceMode(choice))}
        <p class="mt-2 text-meta text-bad" data-testid="path-sync-prod">
          {t("pathSync.prodWarning")}
        </p>
      {/if}
      <p class="mt-2 text-meta">
        {t(ask.kind === "local" ? "pathSync.whereLocal" : "pathSync.whereServer")}
      </p>
    </div>
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        onclick={oncancel}
      >
        {t("common.cancel")}
      </button>
      <button
        type="button"
        data-testid="path-sync-confirm"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover hover:opacity-90"
        onclick={() => onanswer(choice)}
      >
        {t("sftp.followSetupConfirm")}
      </button>
    </div>
  {/if}
</Modal>
