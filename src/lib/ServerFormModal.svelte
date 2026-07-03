<script lang="ts">
  // Add/edit server form (extracted from +page.svelte in Phase 18.4.2). Owns the
  // form field state and persistence (add/update + forget-secret); the parent keeps
  // the `servers` list and reacts via `onsaved`/`onforgotten`. Open it through the
  // exported `openAdd`/`openEdit` (via `bind:this`).
  import Modal from "./Modal.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import type { AuthMethod, ServerProfile } from "./types";
  import type { AiExecMode } from "./ai";
  import { addServer, updateServer, forgetSecrets, pickKeyFile } from "./api";
  import { settings } from "./settings.svelte";
  import { notifySuccess, notifyError } from "./stores/toasts.svelte";
  import { t } from "./i18n";

  let {
    onsaved,
    onforgotten,
  }: {
    /** A server was created ("add") or updated ("edit") — merge it into the list. */
    onsaved: (server: ServerProfile, mode: "add" | "edit") => void;
    /** The saved secret for `id` was forgotten — clear its `hasSavedPassword`. */
    onforgotten: (id: string) => void;
  } = $props();

  let open = $state(false);
  let mode = $state<"add" | "edit">("add");
  let editId = $state<string | null>(null);
  let alias = $state("");
  let host = $state("");
  // `null` when the number input is cleared (invalid — backend port is a u16).
  let port = $state<number | null>(22);
  let username = $state("");
  let authMethod = $state<AuthMethod>("password");
  let keyPath = $state<string | null>(null);
  let group = $state("");
  let tagsInput = $state("");
  let autoRecord = $state(false);
  let noAi = $state(false);
  let aiPromptId = $state("");
  let aiExecMode = $state("");
  let confirmForget = $state(false);
  // Set on a failed submit so empty required fields light up; cleared per field
  // as the user types (derived below) and reset when the form (re)opens.
  let submitted = $state(false);

  /** A valid SSH port is an integer in 1…65535 (backend stores it as u16). */
  function portValid(p: number | null): p is number {
    return p != null && Number.isInteger(p) && p >= 1 && p <= 65535;
  }

  const aliasError = $derived(submitted && !alias.trim());
  const hostError = $derived(submitted && !host.trim());
  const usernameError = $derived(submitted && !username.trim());
  const portError = $derived(submitted && !portValid(port));
  const hasErrors = $derived(aliasError || hostError || usernameError || portError);

  /** Open the form to add a new server, optionally pre-filling its folder group. */
  export function openAdd(prefillGroup = "") {
    mode = "add";
    editId = null;
    alias = host = username = "";
    port = settings.defaultPort;
    authMethod = "password";
    keyPath = null;
    group = prefillGroup;
    tagsInput = "";
    autoRecord = false;
    noAi = false;
    aiPromptId = "";
    aiExecMode = "";
    submitted = false;
    open = true;
  }

  /** Open the form to edit an existing server. */
  export function openEdit(server: ServerProfile) {
    mode = "edit";
    editId = server.id;
    alias = server.alias;
    host = server.host;
    port = server.port;
    username = server.username;
    authMethod = server.authMethod;
    keyPath = server.keyPath;
    group = server.group ?? "";
    tagsInput = server.tags.join(", ");
    autoRecord = server.autoRecord;
    noAi = server.noAi;
    aiPromptId = server.chatPromptId ?? "";
    aiExecMode = server.execMode ?? "";
    submitted = false;
    open = true;
  }

  async function browseKey() {
    const picked = await pickKeyFile();
    if (picked) keyPath = picked;
  }

  async function forget() {
    if (!editId) return;
    try {
      await forgetSecrets(editId);
      onforgotten(editId);
      notifySuccess(t("page.savedSecretRemoved"));
    } catch (e) {
      notifyError(String(e));
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    submitted = true;
    if (!alias.trim() || !host.trim() || !username.trim() || !portValid(port)) return;
    const tags = tagsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const payload = {
      alias,
      host,
      port,
      username,
      authMethod,
      keyPath,
      group: group.trim() || null,
      tags,
      autoRecord,
      noAi,
      chatPromptId: aiPromptId || null,
      execMode: (aiExecMode || null) as AiExecMode | null,
    };
    try {
      if (mode === "edit" && editId) {
        const updated = await updateServer(editId, payload);
        onsaved(updated, "edit");
        notifySuccess(t("page.serverUpdated", { alias: updated.alias }));
      } else {
        const created = await addServer(payload);
        onsaved(created, "add");
        notifySuccess(t("page.serverAdded", { alias: created.alias }));
      }
      open = false;
    } catch (e) {
      notifyError(String(e));
    }
  }
</script>

<Modal
  {open}
  title={mode === "edit" ? t("page.editServerTitle") : t("page.newServerTitle")}
  onclose={() => (open = false)}
>
  <form onsubmit={submit}>
    <label class="mb-2 block text-xs text-muted">
      {t("page.alias")}
      <input
        data-testid="field-alias"
        class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent {aliasError
          ? 'border-danger'
          : 'border-edge'}"
        aria-invalid={aliasError}
        bind:value={alias}
        placeholder={t("page.aliasPlaceholder")}
      />
      {#if aliasError}
        <span class="mt-1 block text-[11px] text-danger">{t("page.fieldRequired")}</span>
      {/if}
    </label>
    <label class="mb-2 block text-xs text-muted">
      {t("page.hostIp")}
      <input
        data-testid="field-host"
        class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent {hostError
          ? 'border-danger'
          : 'border-edge'}"
        aria-invalid={hostError}
        bind:value={host}
        placeholder="192.168.1.10"
      />
      {#if hostError}
        <span class="mt-1 block text-[11px] text-danger">{t("page.fieldRequired")}</span>
      {/if}
    </label>
    <div class="mb-2 flex gap-2">
      <label class="block w-20 text-xs text-muted">
        {t("page.port")}
        <input
          type="number"
          data-testid="field-port"
          class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent {portError
            ? 'border-danger'
            : 'border-edge'}"
          aria-invalid={portError}
          bind:value={port}
        />
      </label>
      <label class="block flex-1 text-xs text-muted">
        {t("page.username")}
        <input
          data-testid="field-username"
          class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent {usernameError
            ? 'border-danger'
            : 'border-edge'}"
          aria-invalid={usernameError}
          bind:value={username}
          placeholder="root"
        />
        {#if usernameError}
          <span class="mt-1 block text-[11px] text-danger">{t("page.fieldRequired")}</span>
        {/if}
      </label>
    </div>
    {#if portError}
      <p class="mb-2 text-[11px] text-danger">{t("page.portInvalid")}</p>
    {/if}

    <div class="mb-2 text-xs text-muted">
      {t("page.authentication")}
      <div class="mt-1 flex gap-3 text-sm text-white">
        <label class="flex items-center gap-1">
          <input type="radio" value="password" bind:group={authMethod} />
          {t("page.authPassword")}
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="key" bind:group={authMethod} />
          {t("page.authKey")}
        </label>
      </div>
    </div>

    {#if authMethod === "key"}
      <label class="mb-2 block text-xs text-muted">
        {t("page.privateKeyFile")}
        <div class="mt-1 flex gap-2">
          <input
            readonly
            class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none"
            value={keyPath ?? ""}
            placeholder="~/.ssh/id_ed25519"
          />
          <button
            type="button"
            class="shrink-0 rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
            onclick={browseKey}>{t("common.browse")}</button
          >
        </div>
      </label>
    {/if}

    <label class="mb-2 block text-xs text-muted">
      {t("page.tags")}
      <input
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        bind:value={tagsInput}
        placeholder="web, eu"
      />
    </label>

    <label class="mb-2 flex items-center gap-2 text-xs text-text">
      <input type="checkbox" bind:checked={autoRecord} />
      {t("page.autoRecord")}
    </label>
    <p class="mb-2 text-[11px] text-muted">{t("page.autoRecordHint")}</p>

    <label class="mb-2 flex items-center gap-2 text-xs text-text">
      <input type="checkbox" data-testid="server-no-ai" bind:checked={noAi} />
      {t("page.noAi")}
    </label>
    <p class="mb-2 text-[11px] text-muted">{t("page.noAiHint")}</p>

    {#if settings.ai.prompts.chat.prompts.length > 1}
      <label class="mb-2 block text-xs text-text">
        {t("page.aiPrompt")}
        <select
          class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          data-testid="server-ai-prompt"
          bind:value={aiPromptId}
        >
          <option value="">{t("page.aiPromptDefault")}</option>
          {#each settings.ai.prompts.chat.prompts as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>
      <p class="mb-2 text-[11px] text-muted">{t("page.aiPromptHint")}</p>
    {/if}

    <label class="mb-2 block text-xs text-text">
      {t("page.aiExec")}
      <select
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        data-testid="server-ai-exec"
        bind:value={aiExecMode}
      >
        <option value="">{t("page.aiExecDefault")}</option>
        <option value="suggest">{t("settings.aiExecSuggest")}</option>
        <option value="confirm">{t("settings.aiExecConfirm")}</option>
        <option value="auto">{t("settings.aiExecAuto")}</option>
        <option value="dialogConfirm">{t("settings.aiExecDialogConfirm")}</option>
        <option value="dialog">{t("settings.aiExecDialog")}</option>
      </select>
    </label>
    <p class="mb-2 text-[11px] text-muted">{t("page.aiExecHint")}</p>

    {#if hasErrors}
      <p class="mb-2 text-xs text-danger" role="alert">{t("page.fixRequiredFields")}</p>
    {/if}

    <div class="mt-3 flex items-center gap-2">
      {#if mode === "edit"}
        <button
          type="button"
          class="rounded px-2 py-1 text-xs text-danger hover:underline"
          onclick={() => (confirmForget = true)}
          title={t("page.forgetSavedSecretTitle")}
        >
          {t("page.forgetSavedSecret")}
        </button>
      {/if}
      <div class="ml-auto flex gap-2">
        <button
          type="button"
          class="rounded px-3 py-1 text-sm text-muted hover:text-white"
          onclick={() => (open = false)}>{t("common.cancel")}</button
        >
        <button
          type="submit"
          data-testid="save-server"
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
          >{mode === "edit" ? t("common.update") : t("common.save")}</button
        >
      </div>
    </div>
  </form>
</Modal>

<!-- Forget-secret confirmation -->
<ConfirmDialog
  open={confirmForget}
  title={t("page.forgetSecretTitle")}
  confirmLabel={t("common.forget")}
  onconfirm={async () => {
    await forget();
    confirmForget = false;
  }}
  oncancel={() => (confirmForget = false)}
>
  {t("page.forgetSecretBody")}
</ConfirmDialog>
