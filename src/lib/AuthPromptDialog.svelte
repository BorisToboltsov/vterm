<script lang="ts">
  // The server's own login questions (keyboard-interactive, v1.0.38) that vterm
  // couldn't answer with the stored password: a one-time code, a Duo choice, a
  // second round. Hidden questions get a PasswordInput, shown ones a plain field.
  // Everything here comes from the server and is rendered as text. Answers go
  // straight to the backend and are dropped from this component on submit —
  // never stored, never logged.
  import Modal from "./Modal.svelte";
  import PasswordInput from "./PasswordInput.svelte";
  import { answerAuthPrompt } from "./api";
  import { notifyError } from "./stores/toasts.svelte";
  import type { AuthPromptRequest } from "./types";
  import { t } from "./i18n";

  let {
    sessionId,
    request,
    ondone,
  }: {
    sessionId: string;
    request: AuthPromptRequest;
    /** Answered or cancelled — the caller drops the pending request. */
    ondone: () => void;
  } = $props();

  let answers = $state<string[]>([]);
  let busy = $state(false);
  // A new round (or another session's questions) starts with empty fields.
  $effect(() => {
    answers = request.prompts.map(() => "");
  });

  async function send(values: string[] | null) {
    if (busy) return;
    busy = true;
    try {
      await answerAuthPrompt(sessionId, values);
    } catch (e) {
      // The login already ended (timed out on the server, tab reconnected).
      notifyError(String(e));
    } finally {
      answers = request.prompts.map(() => "");
      busy = false;
      ondone();
    }
  }

  function submit(e: Event) {
    e.preventDefault();
    void send([...answers]);
  }
</script>

<Modal
  open
  title={request.stage === "proxy" ? t("authPrompt.titleProxy") : t("authPrompt.title")}
  onclose={() => void send(null)}
>
  <form onsubmit={submit} data-testid="auth-prompt">
    <p class="mb-3 font-mono text-xs text-muted">{request.username}@{request.host}</p>
    {#if request.name}
      <p class="mb-1 text-sm text-text">{request.name}</p>
    {/if}
    {#if request.instructions}
      <p class="mb-3 whitespace-pre-line text-xs text-muted" data-testid="auth-prompt-instructions">
        {request.instructions}
      </p>
    {/if}
    {#each request.prompts as p, i (i)}
      <label class="mb-3 block text-xs text-muted">
        <span class="whitespace-pre-line">{p.prompt.trim()}</span>
        {#if p.echo}
          <input
            class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
            data-testid={`auth-prompt-field-${i}`}
            autocomplete="off"
            spellcheck="false"
            bind:value={answers[i]}
          />
        {:else}
          <PasswordInput testid={`auth-prompt-field-${i}`} class="mt-1" bind:value={answers[i]} />
        {/if}
      </label>
    {/each}
    <p class="mb-3 text-meta text-muted">{t("authPrompt.notStored")}</p>
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        data-testid="auth-prompt-cancel"
        disabled={busy}
        onclick={() => void send(null)}>{t("common.cancel")}</button
      >
      <button
        type="submit"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40"
        data-testid="auth-prompt-submit"
        disabled={busy}>{t("authPrompt.submit")}</button
      >
    </div>
  </form>
</Modal>
