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
  // and in red on production. `sudo` is tried without a password first, then with
  // the session's — saved in the keychain or the login's (ADR 0073): a field for
  // one where none is needed would be a lie, and a password typed for nothing is a
  // password spent. A typed one goes to `sudoCheck` once; the backend keeps it for
  // this session only.
  import { sftpOpenAs, sudoCheck } from "../api";
  import { t } from "../i18n";
  import Modal from "../ui/Modal.svelte";
  import SudoField from "../sudo/SudoField.svelte";
  import { fieldAfter, type SudoFieldState } from "../sudo/sudo";
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
  let remember = $state(true);
  // What sudo said: nothing yet, a password to type, or its refusal.
  let field = $state<SudoFieldState | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const needPassword = $derived(field?.kind === "type");
  const refused = $derived(field?.kind === "refused");

  // Each question starts over: the last one's password and refusal are not this one's.
  $effect(() => {
    if (!ask) return;
    password = "";
    remember = true;
    field = null;
    busy = false;
    failure = null;
  });

  async function confirm() {
    const current = ask;
    if (!current || busy || refused || (needPassword && !password)) return;
    busy = true;
    failure = null;
    try {
      if (needPassword) await sudoCheck(current.sessionId, password, remember);
      await sftpOpenAs(current.sessionId, current.user);
      ondone();
    } catch (e) {
      const f = fileUserFailure(e);
      if (f.kind === "sudo") field = fieldAfter(f.answer);
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
      {#if field}
        {#if needPassword}
          <p class="mb-2 mt-3 text-xs text-muted" data-testid="fileuser-password-hint">
            {t("fileuser.passwordHint", { login: ask.login ?? "" })}
          </p>
        {/if}
        <div class={needPassword ? "" : "mt-3"}>
          <SudoField
            {field}
            who={ask.login ?? ""}
            testid="fileuser"
            bind:password
            bind:remember
          />
        </div>
        {#if refused}
          <p class="mt-2 text-xs text-muted" data-testid="fileuser-without-sudo">{t("fileuser.withoutSudo")}</p>
        {/if}
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
          disabled={busy || refused || (needPassword && !password)}
        >
          {t("fileuser.open")}
        </button>
      </div>
    </form>
  {/if}
</Modal>
