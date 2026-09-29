<script lang="ts">
  // Add/edit server form (extracted from +page.svelte in Phase 18.4.2). Owns the
  // form field state and persistence (add/update + forget-secret); the parent keeps
  // the `servers` list and reacts via `onsaved`/`onforgotten`. Open it through the
  // exported `openAdd`/`openEdit` (via `bind:this`).
  import Modal from "./Modal.svelte";
  import InfoHint from "./InfoHint.svelte";
  import PasswordInput from "./PasswordInput.svelte";
  import KeyGenModal from "./KeyGenModal.svelte";
  import ServerIconPicker from "./ServerIconPicker.svelte";
  import DisclosureRow from "./DisclosureRow.svelte";
  import SegmentedControl from "./SegmentedControl.svelte";
  import Icon from "./Icon.svelte";
  import { resolveServerIcon, resolveServerColorClass } from "./servericons";
  import { isProdServer } from "./aiexec";
  import { tooltip } from "./actions/tooltip";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import type { AuthMethod, ProxyKind, ServerProfile } from "./types";
  import type { AiExecMode } from "./ai";
  import {
    addServer,
    updateServer,
    forgetSecrets,
    pickKeyFile,
    saveServerSecret,
    saveProxySecret,
  } from "./api";
  import { settings } from "./settings.svelte";
  import { notifySuccess, notifyError } from "./stores/toasts.svelte";
  import {
    DEFAULT_USERNAME,
    isValidHost,
    isValidPort,
    parseTags,
    previewTags,
    proxyEndpoint,
    recordingSummaryKeys,
    usernameOrDefault,
  } from "./serverform";
  import { t } from "./i18n";

  let {
    onsaved,
    onforgotten,
    onOpenAiPrompts,
  }: {
    /** A server was created ("add") or updated ("edit") — merge it into the list. */
    onsaved: (server: ServerProfile, mode: "add" | "edit") => void;
    /** The saved secret for `id` was forgotten — clear its `hasSavedPassword`. */
    onforgotten: (id: string) => void;
    /** Deep-link from the AI-prompt hint: open Settings → AI assistant → System prompts. */
    onOpenAiPrompts?: () => void;
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
  // The just-typed password / key passphrase. Never part of the profile payload —
  // it goes straight to the keychain via `saveServerSecret` once the profile has
  // an id. `hasSavedPassword` mirrors the stored hint so the field can say "leave
  // blank to keep" instead of pre-filling a secret (PasswordInput invariant).
  let secret = $state("");
  let hasSavedPassword = $state(false);
  let group = $state("");
  let tagsInput = $state("");
  // Pictogram (icons.ts key via servericons.ts) + colour key, shown before the
  // alias in the list. "" = generic glyph / muted colour.
  let icon = $state("");
  let iconColor = $state("");
  let autoRecord = $state(false);
  let noAi = $state(false);
  let aiPromptId = $state("");
  let aiExecMode = $state("");
  // Proxy / jump host (Phase 21). `proxySecret` is the just-typed jump-host
  // password/passphrase (never persisted on the profile — saved to the keychain
  // via `saveProxySecret`); `proxyHasSavedPassword` mirrors the stored hint.
  let useProxy = $state(false);
  let proxyKind = $state<ProxyKind>("jump");
  let proxyHost = $state("");
  let proxyPort = $state<number | null>(22);
  let proxyUsername = $state("");
  let proxyAuthMethod = $state<AuthMethod>("password");
  let proxyKeyPath = $state<string | null>(null);
  let proxySecret = $state("");
  let proxyHasSavedPassword = $state(false);
  let confirmForget = $state(false);
  const authOptions = $derived<{ value: AuthMethod; label: string }[]>([
    { value: "password", label: t("page.authPassword") },
    { value: "key", label: t("page.authKey") },
  ]);
  // Optional sections start folded on every open; their headers preview the values.
  let appearanceOpen = $state(false);
  let proxyOpen = $state(false);
  let recordingOpen = $state(false);
  // The glyph grid folds inside its section too — open it would dwarf the tags field.
  let iconPickerOpen = $state(false);
  const shownTags = $derived(previewTags(tagsInput));
  const PROXY_KIND_LABEL = {
    jump: "page.proxyKindJump",
    socks5: "page.proxyKindSocks5",
    http: "page.proxyKindHttp",
  } as const;
  const proxySummary = $derived(
    `${t(PROXY_KIND_LABEL[proxyKind])} · ${proxyEndpoint(proxyHost, proxyPort)}`,
  );
  const recordingSummary = $derived(
    recordingSummaryKeys({ autoRecord, noAi, aiPromptId, aiExecMode })
      .map((k) => t(k))
      .join(" · "),
  );

  function foldSections() {
    appearanceOpen = proxyOpen = recordingOpen = iconPickerOpen = false;
  }
  // Set on a failed submit so empty required fields light up; cleared per field
  // as the user types (derived below) and reset when the form (re)opens.
  let submitted = $state(false);

  const aliasError = $derived(submitted && !alias.trim());
  // Empty → "required"; non-empty but malformed → "invalid host/IP".
  const hostEmpty = $derived(submitted && !host.trim());
  const hostError = $derived(submitted && !isValidHost(host));
  const portError = $derived(submitted && !isValidPort(port));
  // Proxy validation only applies when the proxy is enabled.
  const proxyHostError = $derived(submitted && useProxy && !isValidHost(proxyHost));
  const proxyHostEmpty = $derived(submitted && useProxy && !proxyHost.trim());
  const proxyPortError = $derived(submitted && useProxy && !isValidPort(proxyPort));
  const hasErrors = $derived(
    aliasError ||
      hostError ||
      portError ||
      proxyHostError ||
      proxyPortError,
  );

  /** Reset the proxy fields from a profile's proxy (or to defaults when none).
   *  `keepSaved` carries the saved-secret hint (edit) or drops it (add/duplicate,
   *  where secrets never transfer since the keychain is keyed by server id). */
  function loadProxy(proxy: ServerProfile["proxy"], keepSaved: boolean) {
    useProxy = !!proxy;
    proxyKind = proxy?.kind ?? "jump";
    proxyHost = proxy?.host ?? "";
    proxyPort = proxy?.port ?? 22;
    proxyUsername = proxy?.username ?? "";
    proxyAuthMethod = proxy?.authMethod ?? "password";
    proxyKeyPath = proxy?.keyPath ?? null;
    proxySecret = "";
    proxyHasSavedPassword = keepSaved && !!proxy?.hasSavedPassword;
  }

  /** Open the form to add a new server, optionally pre-filling its folder group. */
  export function openAdd(prefillGroup = "") {
    mode = "add";
    editId = null;
    alias = host = username = "";
    port = settings.defaultPort;
    authMethod = "password";
    keyPath = null;
    secret = "";
    hasSavedPassword = false;
    group = prefillGroup;
    tagsInput = "";
    icon = "";
    iconColor = "";
    autoRecord = false;
    noAi = false;
    aiPromptId = "";
    aiExecMode = "";
    loadProxy(null, false);
    foldSections();
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
    secret = "";
    hasSavedPassword = server.hasSavedPassword;
    group = server.group ?? "";
    tagsInput = server.tags.join(", ");
    icon = server.icon;
    iconColor = server.iconColor;
    autoRecord = server.autoRecord;
    noAi = server.noAi;
    aiPromptId = server.chatPromptId ?? "";
    aiExecMode = server.execMode ?? "";
    loadProxy(server.proxy, true);
    foldSections();
    submitted = false;
    open = true;
  }

  /**
   * Open the form pre-filled from an existing server to create a copy. This is
   * an "add" (new id), so the saved secret is intentionally NOT carried over —
   * secrets live in the keychain keyed by server id. Alias gets a "(copy)"
   * suffix so the duplicate is distinguishable at a glance.
   */
  export function openDuplicate(server: ServerProfile) {
    mode = "add";
    editId = null;
    alias = t("page.copyOfAlias", { alias: server.alias });
    host = server.host;
    port = server.port;
    username = server.username;
    authMethod = server.authMethod;
    keyPath = server.keyPath;
    secret = "";
    hasSavedPassword = false;
    group = server.group ?? "";
    tagsInput = server.tags.join(", ");
    icon = server.icon;
    iconColor = server.iconColor;
    autoRecord = server.autoRecord;
    noAi = server.noAi;
    aiPromptId = server.chatPromptId ?? "";
    aiExecMode = server.execMode ?? "";
    // A duplicate is a new id, so neither secret is carried over.
    loadProxy(server.proxy, false);
    foldSections();
    submitted = false;
    open = true;
  }

  // SSH key generator shortcut (Phase 32): open the shared dialog and, on
  // success, point this server at the freshly generated private key.
  let keygenOpen = $state(false);

  async function browseKey() {
    const picked = await pickKeyFile();
    if (picked) keyPath = picked;
  }

  async function browseProxyKey() {
    const picked = await pickKeyFile();
    if (picked) proxyKeyPath = picked;
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
    const proxyBad = useProxy && (!isValidHost(proxyHost) || !isValidPort(proxyPort));
    // The error sits in a section — unfold it rather than point at a closed one.
    if (proxyBad) proxyOpen = true;
    if (!alias.trim() || !isValidHost(host) || !isValidPort(port) || proxyBad) return;
    const tags = parseTags(tagsInput);
    // Secrets never live on the profile — the saved-secret hint is true when one
    // is already stored or the user just typed one (persisted via saveProxySecret).
    const proxy = useProxy
      ? {
          kind: proxyKind,
          host: proxyHost,
          port: proxyPort as number,
          // A jump host is a full SSH login, so an empty field means `root` like
          // the target's; SOCKS/HTTP auth is optional and stays empty.
          username: proxyKind === "jump" ? usernameOrDefault(proxyUsername) : proxyUsername,
          authMethod: proxyAuthMethod,
          keyPath: proxyKeyPath,
          hasSavedPassword: proxySecret.trim() ? true : proxyHasSavedPassword,
        }
      : null;
    const payload = {
      alias,
      host,
      port,
      username: usernameOrDefault(username),
      authMethod,
      keyPath,
      group: group.trim() || null,
      tags,
      autoRecord,
      noAi,
      chatPromptId: aiPromptId || null,
      execMode: (aiExecMode || null) as AiExecMode | null,
      proxy,
      icon,
      iconColor,
    };
    try {
      let saved =
        mode === "edit" && editId
          ? await updateServer(editId, payload)
          : await addServer(payload);
      // Secrets are stored only once the profile has an id, and a failure to
      // reach the keychain must not swallow the profile that was just written:
      // report it and still hand the parent the saved server, or the list would
      // not show a server the backend already has.
      if (secret.trim()) {
        try {
          saved = await saveServerSecret(saved.id, secret);
        } catch (e) {
          notifyError(t("page.secretNotSaved", { error: String(e) }));
        }
      }
      // Store a just-typed proxy secret in the keychain — the jump host's
      // password/passphrase, or the SOCKS5/HTTP basic-auth password (the secret
      // kind follows the proxy's auth method, handled backend-side).
      if (useProxy && proxySecret.trim()) {
        await saveProxySecret(saved.id, proxySecret);
      }
      onsaved(saved, mode === "edit" && editId ? "edit" : "add");
      notifySuccess(
        mode === "edit" && editId
          ? t("page.serverUpdated", { alias: saved.alias })
          : t("page.serverAdded", { alias: saved.alias }),
      );
      open = false;
    } catch (e) {
      notifyError(String(e));
    }
  }
</script>

<Modal
  {open}
  width="w-[30rem]"
  title={mode === "edit" ? t("page.editServerTitle") : t("page.newServerTitle")}
  showClose
  onclose={() => (open = false)}
>
  <form onsubmit={submit}>
    <!-- One column: what a connection needs is always visible; everything optional
         lives in collapsible sections whose header previews the current values, so
         a folded section never hides that something is set. Long hint paragraphs are
         ⓘ tooltips (InfoHint), kept outside checkbox <label>s so a click can't toggle. -->
    <h3 class="mb-2 text-caption uppercase tracking-wider text-muted">{t("page.groupConnection")}</h3>
    <label class="mb-2 block text-xs text-muted">
      {t("page.alias")}
      <input
        data-testid="field-alias"
        class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent {aliasError
          ? 'border-danger'
          : 'border-edge'}"
        aria-invalid={aliasError}
        bind:value={alias}
        placeholder={t("page.aliasPlaceholder")}
      />
      {#if aliasError}
        <span class="mt-1 block text-meta text-danger">{t("page.fieldRequired")}</span>
      {/if}
    </label>
    <div class="mb-2 flex gap-2">
      <label class="block min-w-0 flex-1 text-xs text-muted">
        {t("page.hostIp")}
        <input
          data-testid="field-host"
          class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent {hostError
            ? 'border-danger'
            : 'border-edge'}"
          aria-invalid={hostError}
          bind:value={host}
          placeholder="192.168.1.10"
        />
      </label>
      <label class="block w-20 text-xs text-muted">
        {t("page.port")}
        <input
          type="number"
          data-testid="field-port"
          class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent {portError
            ? 'border-danger'
            : 'border-edge'}"
          aria-invalid={portError}
          bind:value={port}
        />
      </label>
    </div>
    {#if hostError}
      <p class="-mt-1 mb-2 text-meta text-danger">
        {hostEmpty ? t("page.fieldRequired") : t("page.hostInvalid")}
      </p>
    {/if}
    {#if portError}
      <p class="-mt-1 mb-2 text-meta text-danger">{t("page.portInvalid")}</p>
    {/if}
    <label class="mb-2 block text-xs text-muted">
      {t("page.username")}
      <input
        data-testid="field-username"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
        bind:value={username}
        placeholder={DEFAULT_USERNAME}
      />
    </label>

    <div class="mb-2 text-xs text-muted">
      {t("page.authentication")}
      <div class="mt-1">
        <SegmentedControl
          bind:value={authMethod}
          options={authOptions}
          label={t("page.authentication")}
          testid="server-auth"
        />
      </div>
    </div>

    {#if authMethod === "key"}
      <label class="mb-2 block text-xs text-muted">
        {t("page.privateKeyFile")}
        <div class="mt-1 flex gap-2">
          <input
            readonly
            class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none"
            value={keyPath ?? ""}
            placeholder="~/.ssh/id_ed25519"
          />
          <button
            type="button"
            class="shrink-0 rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
            onclick={browseKey}>{t("common.browse")}</button
          >
          <button
            type="button"
            data-testid="server-keygen"
            class="shrink-0 rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
            onclick={() => (keygenOpen = true)}>{t("keygen.generateShort")}</button
          >
        </div>
      </label>
    {/if}

    <label class="mb-3 block text-xs text-muted">
      <span class="flex items-center gap-1">
        {authMethod === "key" ? t("page.secretPassphrase") : t("page.secretPassword")}
        <InfoHint text={t("page.secretHint")} />
      </span>
      <PasswordInput
        testid="server-secret"
        class="mt-1"
        bind:value={secret}
        placeholder={hasSavedPassword ? t("page.secretKeep") : ""}
      />
    </label>

    <!-- ── Appearance & tags ── -->
    <DisclosureRow
      variant="list"
      bind:open={appearanceOpen}
      label={t("page.groupAppearance")}
      testid="server-section-appearance"
    >
      {#snippet preview()}
        <Icon name={resolveServerIcon(icon)} size={14} class={resolveServerColorClass(iconColor)} />
        {#each shownTags as tag (tag)}
          <span
            class="truncate rounded px-1.5 text-caption {isProdServer([tag])
              ? 'bg-bad/15 text-bad'
              : 'bg-edge text-muted'}">{tag}</span
          >
        {/each}
      {/snippet}
    </DisclosureRow>
    {#if appearanceOpen}
      <div class="pb-1 pt-2">
        <div class="mb-2">
          <ServerIconPicker
            bind:icon
            bind:color={iconColor}
            bind:open={iconPickerOpen}
            label={t("page.icon")}
          />
        </div>
        <label class="mb-2 block text-xs text-muted">
          <span class="flex items-center gap-1">
            {t("page.tags")}
            <InfoHint text={t("page.tagsHint")} />
          </span>
          <input
            data-testid="field-tags"
            class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
            bind:value={tagsInput}
            placeholder="web, eu"
          />
        </label>
      </div>
    {/if}

    <!-- ── Proxy / jump host (Phase 21) ── -->
    <DisclosureRow
      variant="list"
      bind:open={proxyOpen}
      label={t("page.groupProxy")}
      testid="server-section-proxy"
    >
      {#snippet preview()}
        <span class="truncate text-muted">
          {useProxy ? proxySummary : t("page.proxyNone")}
        </span>
      {/snippet}
    </DisclosureRow>
    {#if proxyOpen}
      <div class="pb-1 pt-2">
        <div class="flex items-center gap-2 text-xs text-text">
          <input
            type="checkbox"
            id="srv-use-proxy"
            data-testid="server-use-proxy"
            bind:checked={useProxy}
          />
          <label for="srv-use-proxy">{t("page.useProxy")}</label>
          <InfoHint text={t("page.useProxyHint")} />
        </div>

        {#if useProxy}
          <div class="mt-3">
            <label class="mb-2 block text-xs text-muted">
              {t("page.proxyType")}
              <select
                class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
                data-testid="proxy-kind"
                bind:value={proxyKind}
              >
                <option value="jump">{t("page.proxyKindJump")}</option>
                <option value="socks5">{t("page.proxyKindSocks5")}</option>
                <option value="http">{t("page.proxyKindHttp")}</option>
              </select>
            </label>

            <div class="mb-2 flex gap-2">
              <label class="block min-w-0 flex-1 text-xs text-muted">
                {t("page.proxyHost")}
                <input
                  data-testid="proxy-host"
                  class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent {proxyHostError
                    ? 'border-danger'
                    : 'border-edge'}"
                  aria-invalid={proxyHostError}
                  bind:value={proxyHost}
                  placeholder="bastion.corp"
                />
              </label>
              <label class="block w-20 text-xs text-muted">
                {t("page.port")}
                <input
                  type="number"
                  data-testid="proxy-port"
                  class="mt-1 w-full rounded border bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent {proxyPortError
                    ? 'border-danger'
                    : 'border-edge'}"
                  aria-invalid={proxyPortError}
                  bind:value={proxyPort}
                />
              </label>
            </div>
            {#if proxyHostError}
              <p class="-mt-1 mb-2 text-meta text-danger">
                {proxyHostEmpty ? t("page.fieldRequired") : t("page.hostInvalid")}
              </p>
            {/if}
            {#if proxyPortError}
              <p class="-mt-1 mb-2 text-meta text-danger">{t("page.portInvalid")}</p>
            {/if}

            {#if proxyKind === "jump"}
              <label class="mb-2 block text-xs text-muted">
                {t("page.proxyUsername")}
                <input
                  data-testid="proxy-username"
                  class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
                  bind:value={proxyUsername}
                  placeholder={DEFAULT_USERNAME}
                />
              </label>

              <div class="mb-2 text-xs text-muted">
                {t("page.authentication")}
                <div class="mt-1">
                  <SegmentedControl
                    bind:value={proxyAuthMethod}
                    options={authOptions}
                    label={t("page.authentication")}
                    testid="proxy-auth"
                  />
                </div>
              </div>

              {#if proxyAuthMethod === "key"}
                <label class="mb-2 block text-xs text-muted">
                  {t("page.privateKeyFile")}
                  <div class="mt-1 flex gap-2">
                    <input
                      readonly
                      class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none"
                      value={proxyKeyPath ?? ""}
                      placeholder="~/.ssh/id_ed25519"
                    />
                    <button
                      type="button"
                      class="shrink-0 rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
                      onclick={browseProxyKey}>{t("common.browse")}</button
                    >
                  </div>
                </label>
              {/if}

              <label class="mb-1 block text-xs text-muted">
                <span class="flex items-center gap-1">
                  {proxyAuthMethod === "key" ? t("page.proxyPassphrase") : t("page.proxyPassword")}
                  <InfoHint text={t("page.secretHint")} />
                </span>
                <PasswordInput
                  testid="proxy-secret"
                  class="mt-1"
                  bind:value={proxySecret}
                  placeholder={proxyHasSavedPassword ? t("page.secretKeep") : ""}
                />
              </label>
            {:else}
              <!-- SOCKS5 / HTTP CONNECT: optional basic auth (username + password). -->
              <div class="mb-1 flex items-center gap-1 text-xs text-muted">
                {t("page.authentication")}
                <InfoHint text={t("page.proxyOptionalAuth")} />
              </div>
              <label class="mb-2 block text-xs text-muted">
                {t("page.proxyUsername")}
                <input
                  data-testid="proxy-username"
                  class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
                  bind:value={proxyUsername}
                  placeholder="user"
                />
              </label>
              <label class="mb-1 block text-xs text-muted">
                <span class="flex items-center gap-1">
                  {t("page.proxyPassword")}
                  <InfoHint text={t("page.secretHint")} />
                </span>
                <PasswordInput
                  testid="proxy-secret"
                  class="mt-1"
                  bind:value={proxySecret}
                  placeholder={proxyHasSavedPassword ? t("page.secretKeep") : ""}
                />
              </label>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── Recording & AI ── -->
    <DisclosureRow
      variant="list"
      bind:open={recordingOpen}
      label={t("page.groupRecordingAi")}
      testid="server-section-recording"
    >
      {#snippet preview()}
        <span class="truncate text-muted">{recordingSummary}</span>
      {/snippet}
    </DisclosureRow>
    {#if recordingOpen}
      <div class="pb-1 pt-2">
        <div class="mb-3 flex items-center gap-2 text-xs text-text">
          <input type="checkbox" id="srv-auto-record" bind:checked={autoRecord} />
          <label for="srv-auto-record">{t("page.autoRecord")}</label>
          <InfoHint text={t("page.autoRecordHint")} />
        </div>

        <div class="mb-3 flex items-center gap-2 text-xs text-text">
          <input type="checkbox" id="srv-no-ai" data-testid="server-no-ai" bind:checked={noAi} />
          <label for="srv-no-ai">{t("page.noAi")}</label>
          <InfoHint text={t("page.noAiHint")} />
        </div>

        <div class="grid gap-2 sm:grid-cols-2">
          <div class="text-xs text-text">
            <div class="mb-1 flex items-center gap-1">
              <label for="srv-ai-prompt">{t("page.aiPrompt")}</label>
              <InfoHint
                text={t("page.aiPromptHint")}
                onclick={onOpenAiPrompts
                  ? () => {
                      open = false;
                      onOpenAiPrompts();
                    }
                  : undefined}
              />
            </div>
            <select
              id="srv-ai-prompt"
              class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
              data-testid="server-ai-prompt"
              bind:value={aiPromptId}
            >
              <option value="">{t("page.aiPromptDefault")}</option>
              {#each settings.ai.prompts.chat.prompts as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          </div>

          <div class="text-xs text-text">
            <div class="mb-1 flex items-center gap-1">
              <label for="srv-ai-exec">{t("page.aiExec")}</label>
              <InfoHint text={t("page.aiExecHint")} />
            </div>
            <select
              id="srv-ai-exec"
              class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
              data-testid="server-ai-exec"
              bind:value={aiExecMode}
            >
              <option value="">{t("page.aiExecDefault")}</option>
              <option value="suggest">{t("settings.aiExecSuggest")}</option>
              <option value="confirm">{t("settings.aiExecConfirm")}</option>
              <option value="dialogConfirm">{t("settings.aiExecDialogConfirm")}</option>
              <option value="dialog">{t("settings.aiExecDialog")}</option>
            </select>
          </div>
        </div>
      </div>
    {/if}

    {#if hasErrors}
      <p class="mb-2 mt-1 text-xs text-danger" role="alert">{t("page.fixRequiredFields")}</p>
    {/if}

    <div class="mt-3 flex items-center gap-2 border-t border-edge pt-3">
      {#if mode === "edit"}
        <button
          type="button"
          class="rounded px-2 py-1 text-xs text-danger hover:underline"
          onclick={() => (confirmForget = true)}
          use:tooltip={t("page.forgetSavedSecretTitle")}
        >
          {t("page.forgetSavedSecret")}
        </button>
      {/if}
      <div class="ml-auto flex gap-2">
        <button
          type="button"
          class="rounded px-3 py-1 text-sm text-muted hover:text-text"
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

<!-- SSH key generator (Phase 32): fills the key path on success. -->
<KeyGenModal
  bind:open={keygenOpen}
  defaultComment={host.trim() ? `${usernameOrDefault(username)}@${host.trim()}` : ""}
  ongenerated={(key) => (keyPath = key.path)}
/>
