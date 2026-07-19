<script lang="ts">
  // SSH key-pair generation dialog (Phase 32). One reusable flow behind two entry
  // points: the Utilities panel (UtilKeys, Phase 33) and the server-form
  // "Generate…" shortcut. All decisions (algorithms, default name, path assembly, validation)
  // live in sshkeygen.ts; this component is just the form + collision handling +
  // result view. When `ongenerated` is provided (server form), the done screen
  // offers "use this key"; otherwise it just closes.
  import Modal from "./Modal.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import PasswordInput from "./PasswordInput.svelte";
  import { t, type MessageKey } from "./i18n";
  import { tooltip } from "./actions/tooltip";
  import {
    generateSshKey,
    keyPathExists,
    savePublicKey,
    isKeyExistsError,
    type GeneratedKey,
  } from "./api";
  import {
    KEY_ALGORITHMS,
    SSH_DIR,
    defaultKeyName,
    validateKeyName,
    validateKeyPath,
    resolvedPath,
    buildGenerateRequest,
    isFormValid,
    type KeygenForm,
    type NameError,
    type PathError,
  } from "./sshkeygen";

  // Validation reasons → literal message keys (t() needs a MessageKey literal).
  const NAME_ERR: Record<NameError, MessageKey> = {
    empty: "keygen.nameEmpty",
    separator: "keygen.nameSeparator",
    dots: "keygen.nameDots",
  };
  const PATH_ERR: Record<PathError, MessageKey> = {
    empty: "keygen.pathEmpty",
    notAbsolute: "keygen.pathNotAbsolute",
  };

  let {
    open = $bindable(false),
    defaultComment = "",
    ongenerated,
    onclose,
  }: {
    open?: boolean;
    /** Pre-fill the comment (server form passes `user@host`). */
    defaultComment?: string;
    /** When set, the done screen offers "use this key" with the generated pair. */
    ongenerated?: (key: GeneratedKey) => void;
    onclose?: () => void;
  } = $props();

  // Human labels for the algorithm registry (ids stay in sshkeygen.ts).
  const ALGO_LABEL: Record<string, MessageKey> = {
    ed25519: "keygen.algoEd25519",
    "rsa-4096": "keygen.algoRsa4096",
    "rsa-2048": "keygen.algoRsa2048",
    "ecdsa-p256": "keygen.algoEcdsaP256",
  };

  let form = $state<KeygenForm>(blankForm());
  let confirmPass = $state("");
  let submitted = $state(false);
  let busy = $state(false);
  let error = $state("");
  let collision = $state(false);
  let exists = $state(false);
  let result = $state<GeneratedKey | null>(null);
  let copied = $state(false);
  let saved = $state(false);

  function blankForm(): KeygenForm {
    return {
      algorithm: "ed25519",
      dir: SSH_DIR,
      name: "id_ed25519",
      useCustomPath: false,
      customPath: "",
      passphrase: "",
      comment: "",
    };
  }

  // Reset everything each time the dialog opens. Build the fresh form in a local
  // first and assign once — reading `form` here (e.g. `form.comment = …`) while
  // the effect also writes it would make the effect depend on its own output and
  // loop (freezing the dialog).
  $effect(() => {
    if (!open) return;
    const fresh = blankForm();
    fresh.comment = defaultComment;
    form = fresh;
    confirmPass = "";
    submitted = false;
    busy = false;
    error = "";
    collision = false;
    result = null;
    copied = false;
    saved = false;
    exists = false;
    // Deferred so the read of `form` happens outside this effect's tracking
    // (otherwise the effect would depend on state it just wrote and loop).
    void Promise.resolve().then(checkExists);
  });

  // Keep the suggested file name in sync with the algorithm until the user has
  // typed their own (i.e. while it still equals a known default).
  function onAlgorithmChange(next: string) {
    const wasDefault = KEY_ALGORITHMS.some((a) => a.defaultName === form.name);
    form.algorithm = next;
    if (wasDefault) form.name = defaultKeyName(next);
    void checkExists();
  }

  const path = $derived(resolvedPath(form));
  const nameErr = $derived(form.useCustomPath ? null : validateKeyName(form.name));
  const pathErr = $derived(form.useCustomPath ? validateKeyPath(form.customPath) : null);
  const passMismatch = $derived(form.passphrase !== "" && confirmPass !== form.passphrase);

  // Live collision hint, driven imperatively from the input handlers (not a
  // reactive `$effect`, which — writing `exists` while reading `form` — looped).
  async function checkExists() {
    const p = resolvedPath(form);
    if (!p || !isFormValid(form)) {
      exists = false;
      return;
    }
    try {
      exists = await keyPathExists(p);
    } catch {
      exists = false;
    }
  }

  const canSubmit = $derived(isFormValid(form) && !passMismatch && !busy);

  async function submit() {
    submitted = true;
    if (!canSubmit) return;
    // Re-check at submit (authoritative) — a collision routes through the confirm
    // dialog first; the backend also guards with `key-exists` as a backstop.
    let taken = exists;
    try {
      taken = await keyPathExists(path);
    } catch {
      /* keep the last-known value on a transient failure */
    }
    if (taken) {
      exists = taken;
      collision = true;
      return;
    }
    await run(false);
  }

  async function run(overwrite: boolean) {
    busy = true;
    error = "";
    try {
      result = await generateSshKey(buildGenerateRequest(form, overwrite));
    } catch (e) {
      if (isKeyExistsError(e)) {
        // Raced with another writer between the check and the write.
        collision = true;
      } else {
        error = t("keygen.failed", { error: String(e) });
      }
    } finally {
      busy = false;
    }
  }

  async function copyPublic() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.publicKey);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  }

  async function savePublic() {
    if (!result) return;
    try {
      await savePublicKey(result.path, result.publicKey);
      saved = true;
      setTimeout(() => (saved = false), 1500);
    } catch (e) {
      error = t("keygen.failed", { error: String(e) });
    }
  }

  function close() {
    open = false;
    onclose?.();
  }
</script>

<Modal {open} title={t("keygen.title")} width="w-[30rem]" showClose onclose={close}>
  {#if result}
    <!-- Done: show the public key + fingerprint, offer copy / use. -->
    <div class="space-y-3 text-xs text-muted" data-testid="keygen-done">
      <p class="flex items-center gap-1 text-accent">
        <Icon name="check" size={14} />{t("keygen.success")}
      </p>
      <p>{t("keygen.savedTo", { path: result.path })}</p>

      <div>
        <div class="mb-1 flex items-center justify-between">
          <span>{t("keygen.publicKey")}<InfoHint text={t("keygen.publicKeyHint")} /></span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              data-testid="keygen-copy"
              class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-white"
              onclick={copyPublic}
            >
              <Icon name={copied ? "check" : "copy"} size={12} />
              {copied ? t("keygen.copied") : t("keygen.copyPublic")}
            </button>
            <button
              type="button"
              data-testid="keygen-save"
              class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-white"
              onclick={savePublic}
            >
              <Icon name={saved ? "check" : "save"} size={12} />
              {saved ? t("keygen.saved") : t("keygen.savePublic")}
            </button>
          </div>
        </div>
        <textarea
          readonly
          rows="3"
          class="w-full resize-none break-all rounded border border-edge bg-panel px-2 py-1 font-mono text-[11px] text-white outline-none"
          value={result.publicKey}
        ></textarea>
      </div>

      <p class="font-mono text-[11px] text-muted">{result.fingerprint}</p>

      <div class="flex justify-end gap-2 pt-1">
        {#if ongenerated}
          <button
            type="button"
            data-testid="keygen-use"
            class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
            onclick={() => {
              ongenerated?.(result!);
              close();
            }}>{t("keygen.useThisKey")}</button
          >
        {:else}
          <button
            type="button"
            class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
            onclick={close}>{t("common.done")}</button
          >
        {/if}
      </div>
    </div>
  {:else}
    <!-- Form -->
    <div class="space-y-3 text-xs text-muted">
      <label class="block">
        {t("keygen.algorithm")}
        <select
          data-testid="keygen-algorithm"
          class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          value={form.algorithm}
          onchange={(e) => onAlgorithmChange(e.currentTarget.value)}
        >
          {#each KEY_ALGORITHMS as algo (algo.id)}
            <option value={algo.id}>{t(ALGO_LABEL[algo.id])}</option>
          {/each}
        </select>
      </label>

      {#if !form.useCustomPath}
        <label class="block">
          {t("keygen.fileName")}
          <input
            data-testid="keygen-name"
            class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
            bind:value={form.name}
            oninput={checkExists}
          />
        </label>
      {:else}
        <label class="block">
          {t("keygen.fullPath")}
          <input
            data-testid="keygen-path"
            class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
            bind:value={form.customPath}
            placeholder="~/.ssh/id_ed25519"
            oninput={checkExists}
          />
        </label>
      {/if}

      <!-- Resolved destination + validation / collision hint. -->
      {#if submitted && nameErr}
        <p class="text-[11px] text-danger">{t(NAME_ERR[nameErr])}</p>
      {:else if submitted && pathErr}
        <p class="text-[11px] text-danger">{t(PATH_ERR[pathErr])}</p>
      {:else}
        <p class="break-all font-mono text-[11px] text-muted">
          → {path}
          {#if exists}<span class="text-warn">· {t("keygen.exists")}</span>{/if}
        </p>
      {/if}

      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          bind:checked={form.useCustomPath}
          data-testid="keygen-custompath"
          onchange={checkExists}
        />
        {t("keygen.customPath")}
      </label>

      <div class="flex gap-2">
        <label class="block flex-1">
          {t("keygen.passphrase")}
          <PasswordInput testid="keygen-passphrase" class="mt-1" bind:value={form.passphrase} />
        </label>
        <label class="block flex-1">
          {t("keygen.passphraseConfirm")}
          <PasswordInput testid="keygen-passphrase-confirm" class="mt-1" bind:value={confirmPass} />
        </label>
      </div>
      {#if passMismatch}
        <p class="text-[11px] text-danger">{t("keygen.passphraseMismatch")}</p>
      {/if}

      <label class="block">
        {t("keygen.comment")}
        <input
          data-testid="keygen-comment"
          class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          bind:value={form.comment}
          placeholder="user@host"
        />
      </label>

      {#if error}
        <p class="text-[11px] text-danger" data-testid="keygen-error">{error}</p>
      {/if}

      <div class="flex justify-end gap-2 pt-1">
        <button
          type="button"
          data-testid="keygen-submit"
          disabled={busy}
          use:tooltip={busy ? t("keygen.generating") : undefined}
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-50"
          onclick={submit}>{busy ? t("keygen.generating") : t("keygen.generate")}</button
        >
      </div>
    </div>
  {/if}
</Modal>

<!-- Collision: overwrite, or go back and change the name/path. -->
<ConfirmDialog
  open={collision}
  title={t("keygen.overwriteTitle")}
  confirmLabel={t("keygen.overwrite")}
  onconfirm={() => {
    collision = false;
    run(true);
  }}
  oncancel={() => (collision = false)}
>
  {t("keygen.overwriteBody", { path })}
</ConfirmDialog>
