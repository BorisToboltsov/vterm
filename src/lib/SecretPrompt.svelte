<script lang="ts">
  // Password / key-passphrase prompt shown before connecting when the secret isn't
  // already in the keychain (extracted from +page.svelte in Phase 18.4.4). Owns the
  // prompt state and opens the tab with the typed secret on submit. Open it via the
  // exported `prompt(server, label, error?)` (through `bind:this`). The secret lives
  // only in this component's state until it's handed to the tab store.
  import Modal from "./Modal.svelte";
  import type { ServerProfile } from "./types";
  import { openTab } from "./stores/tabs.svelte";
  import { t } from "./i18n";

  let target = $state<ServerProfile | null>(null);
  let label = $state("Password");
  let value = $state("");
  let remember = $state(false);
  let error = $state("");

  /** Open the prompt for `server`. `label` is "Password" | "Passphrase" (from the
   *  connect plan); `error` shows a red banner when re-prompting after a rejection. */
  export function prompt(server: ServerProfile, secretLabel: string, secretError = "") {
    target = server;
    label = secretLabel;
    value = "";
    remember = false;
    error = secretError;
  }

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }

  function submit(event: Event) {
    event.preventDefault();
    if (!target) return;
    openTab(target.id, target.alias, value, remember);
    target = null;
    value = "";
    remember = false;
  }
</script>

<!-- Secret prompt (password or key passphrase) -->
<Modal open={!!target} title={t("page.secretTitle")} onclose={() => (target = null)}>
  {#if target}
    <form onsubmit={submit}>
      <p class="mb-3 text-xs text-muted">
        {target.username}@{target.host}:{target.port}
      </p>
      {#if error}
        <p class="mb-3 rounded border border-danger px-2 py-1 text-xs text-danger">{error}</p>
      {/if}
      <label class="block text-xs text-muted">
        {label === "Passphrase" ? t("page.secretPassphrase") : t("page.secretPassword")}
        <input
          type="password"
          data-testid="secret-input"
          use:focusOnMount
          class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          bind:value
        />
      </label>
      <label class="mt-3 flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" bind:checked={remember} />
        {t("page.rememberKeychain")}
      </label>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded px-3 py-1 text-sm text-muted hover:text-white"
          onclick={() => (target = null)}>{t("common.cancel")}</button
        >
        <button
          type="submit"
          data-testid="secret-connect"
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
          >{t("common.connect")}</button
        >
      </div>
    </form>
  {/if}
</Modal>
