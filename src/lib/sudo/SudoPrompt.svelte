<script lang="ts">
  // The editor's sudo prompt (ADR 0073): to reopen a file as root, to edit one as
  // root ahead of a save, or to save one as root. Either a password to type —
  // with why it is asked (a saved one turned down, a wrong one) and "remember in
  // the keychain" — or, where sudo needs no typing but the server is prod, one
  // explicit "yes" naming whose password goes. The flow (`page/editorflow`) owns
  // the state; this only draws it.
  import { t } from "../i18n";
  import Modal from "../ui/Modal.svelte";
  import SudoField from "./SudoField.svelte";
  import type { SudoAsk } from "../page/editorflow.svelte";
  import type { SudoFieldState } from "./sudo";

  let {
    ask,
    who = "",
    prod = false,
    busy = false,
    password = $bindable(""),
    remember = $bindable(true),
    onconfirm,
    oncancel,
  }: {
    ask: SudoAsk | null;
    /** `user@server` whose sudo it is. */
    who?: string;
    prod?: boolean;
    busy?: boolean;
    password?: string;
    remember?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  const path = $derived(ask ? (ask.kind === "open" ? ask.path : ask.doc.path) : "");
  const title = $derived(
    ask?.kind === "save" ? t("editor.sudoSaveTitle") : ask?.kind === "check" ? t("sudo.elevate") : t("editor.sudoTitle"),
  );
  const confirmLabel = $derived(
    ask?.kind === "save" ? t("editor.save") : ask?.kind === "check" ? t("sudo.elevate") : t("editor.sudoOpen"),
  );
  const field = $derived<SudoFieldState | null>(
    !ask ? null : ask.mode === "type" ? { kind: "type", note: ask.note } : ask.source ? { kind: "ready", source: ask.source } : null,
  );
</script>

<Modal open={!!ask} {title} onclose={oncancel}>
  {#if ask}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        onconfirm();
      }}
    >
      <p class="mb-3 break-all text-xs text-muted" data-testid="sudo-prompt-path">
        {who ? `${who} · ` : ""}{path}
      </p>
      {#if prod}
        <p class="mb-3 rounded border border-bad/50 bg-bad/10 px-2.5 py-1.5 text-xs text-bad" data-testid="sudo-prompt-prod">
          {t("sudo.prodWarning")}
        </p>
      {/if}
      {#if field}
        <SudoField {field} {who} testid="sudo-prompt" bind:password bind:remember />
      {/if}
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={oncancel}>
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          data-testid="sudo-prompt-confirm"
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40"
          disabled={busy || (ask.mode === "type" && !password)}
        >
          {confirmLabel}
        </button>
      </div>
    </form>
  {/if}
</Modal>
