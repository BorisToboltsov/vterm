<script lang="ts" module>
  /** Whom to take on, and what the question has to say about it. */
  export interface FileUserAsk {
    sessionId: string;
    user: string;
    login: string | null;
    prod: boolean;
  }
</script>

<script lang="ts">
  // The question before the file panel works as another user (v1.26, ADR 0047).
  // What it creates from then on belongs to that user, so it is asked every time,
  // and in red on production. `sudo` is tried without a password first: a field for
  // one where none is needed would be a lie, and a password typed for nothing is a
  // password spent. It stays in the backend's memory for this session only.
  import { sftpOpenAs } from "../api";
  import { t } from "../i18n";
  import Modal from "../ui/Modal.svelte";
  import PasswordInput from "../ui/PasswordInput.svelte";
  import { fileUserFailure } from "./fileuser";

  let {
    ask,
    onclose,
    ondone,
  }: {
    ask: FileUserAsk | null;
    onclose: () => void;
    /** The panel works as that user now. */
    ondone: () => void;
  } = $props();

  let password = $state("");
  let needPassword = $state(false);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  // Each question starts over: the last one's password and refusal are not this one's.
  $effect(() => {
    if (!ask) return;
    password = "";
    needPassword = false;
    busy = false;
    failure = null;
  });

  async function confirm() {
    const current = ask;
    if (!current || busy || (needPassword && !password)) return;
    busy = true;
    failure = null;
    try {
      await sftpOpenAs(current.sessionId, current.user, needPassword ? password : null);
      ondone();
    } catch (e) {
      const f = fileUserFailure(e);
      if (f.kind === "needPassword") needPassword = true;
      else if (f.kind === "wrongPassword") failure = t("fileuser.wrongPassword");
      else if (f.kind === "refused") failure = t("fileuser.refused", { reason: f.reason });
      else if (f.kind === "noServer") failure = t("fileuser.noServer");
      else failure = f.text;
      password = "";
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  open={!!ask}
  title={ask ? t("fileuser.title", { user: ask.user }) : ""}
  titleClass="text-accent"
  width="w-[30rem]"
  {onclose}
>
  {#if ask}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void confirm();
      }}
    >
      {#if ask.prod}
        <p
          class="mb-3 rounded border border-bad/50 bg-bad/10 px-2.5 py-2 text-xs text-bad"
          data-testid="fileuser-prod"
        >
          {t("fileuser.prod", { user: ask.user })}
        </p>
      {/if}
      <p class="text-xs text-muted">{t("fileuser.body", { user: ask.user })}</p>
      {#if needPassword}
        <p class="mb-2 mt-3 text-xs text-muted" data-testid="fileuser-password-hint">
          {t("fileuser.passwordHint", { login: ask.login ?? "" })}
        </p>
        <PasswordInput
          testid="fileuser-password"
          autofocus
          placeholder={t("editor.sudoPassword")}
          bind:value={password}
        />
      {/if}
      {#if failure}
        <p class="mt-2 break-words text-xs text-bad" data-testid="fileuser-failure">{failure}</p>
      {/if}
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded px-3 py-1 text-sm text-muted hover:text-text"
          onclick={onclose}
        >
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40"
          data-testid="fileuser-confirm"
          disabled={busy || (needPassword && !password)}
        >
          {t("fileuser.open")}
        </button>
      </div>
    </form>
  {/if}
</Modal>
