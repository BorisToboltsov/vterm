<script lang="ts">
  // AI assistant settings (Phase 17, opt-in). Master switch + endpoint management
  // (provider/baseUrl/model/key) + output contract, executor mode and context tiers.
  // API keys never live in settings — they go straight to the keychain via the
  // backend; here we only track the `hasKey` flag.
  import { settings } from "./settings.svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    newAiEndpoint,
    newAiPrompt,
    parseParams,
    mergeModelOptions,
    DEFAULT_PROMPT,
    AI_PROMPT_KINDS,
    type AiProvider,
    type AiPromptKind,
    type AiEndpoint,
  } from "./ai";
  import { setAiKey, forgetAiKey, aiModels } from "./api";
  import { describeAiError } from "./aierror";
  import DisclosureRow from "./DisclosureRow.svelte";
  import Icon from "./Icon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { t } from "./i18n";

  // Collapsible prompt sections (whole section + per kind).
  let promptsOpen = $state(false);
  let kindOpen = $state<Record<AiPromptKind, boolean>>({
    chat: false,
    runbook: false,
    sh: false,
    ansible: false,
  });
  function kindLabel(k: AiPromptKind): string {
    return k === "chat"
      ? t("settings.aiChatPrompt")
      : k === "runbook"
        ? t("settings.aiRunbookPrompt")
        : k === "sh"
          ? t("settings.aiScriptShPrompt")
          : t("settings.aiScriptAnsiblePrompt");
  }

  function addPrompt(kind: AiPromptKind) {
    const set = settings.ai.prompts[kind];
    const p = newAiPrompt(kind, t("settings.aiPromptNewName"));
    set.prompts = [...set.prompts, p];
    set.activeId = set.activeId ?? p.id;
  }
  function removePrompt(kind: AiPromptKind, id: string) {
    const set = settings.ai.prompts[kind];
    if (set.prompts.length <= 1) return;
    set.prompts = set.prompts.filter((p) => p.id !== id);
    if (set.activeId === id) set.activeId = set.prompts[0]?.id ?? null;
  }

  // Transient API-key drafts — never persisted (keys live in the keychain).
  let keyDrafts = $state<Record<string, string>>({});
  let deleteId = $state<string | null>(null);
  // Connection-check state per endpoint (transient).
  let checking = $state<Record<string, boolean>>({});
  let checkResult = $state<Record<string, { ok: boolean; models: string[]; error?: string }>>({});
  // Per-endpoint "Advanced" (base prompt + params JSON) disclosure state — seeded
  // for current endpoints so `bind:open` never binds undefined (new ones seeded in
  // addEndpoint).
  let advancedOpen = $state<Record<string, boolean>>(
    Object.fromEntries(settings.ai.endpoints.map((e) => [e.id, false])),
  );
  const paramsInvalid = (ep: AiEndpoint): boolean =>
    (ep.params ?? "").trim() !== "" && parseParams(ep.params) === null;

  /** Probe an endpoint: list its models (also confirms it's reachable). */
  async function checkConn(ep: AiEndpoint) {
    checking[ep.id] = true;
    try {
      const models = await aiModels({ endpointId: ep.id, provider: ep.provider, baseUrl: ep.baseUrl });
      checkResult[ep.id] = { ok: true, models };
    } catch (e) {
      checkResult[ep.id] = { ok: false, models: [], error: describeAiError(e) };
    } finally {
      checking[ep.id] = false;
    }
  }

  const ai = $derived(settings.ai);

  function addEndpoint(provider: AiProvider) {
    const ep = newAiEndpoint(provider);
    advancedOpen[ep.id] = false; // seed before it renders (bind:open needs a boolean)
    settings.ai.endpoints = [...settings.ai.endpoints, ep];
    if (!settings.ai.activeEndpointId) settings.ai.activeEndpointId = ep.id;
  }

  async function saveKey(id: string) {
    const k = (keyDrafts[id] ?? "").trim();
    if (!k) return;
    await setAiKey(id, k);
    const ep = settings.ai.endpoints.find((e) => e.id === id);
    if (ep) ep.hasKey = true;
    keyDrafts[id] = "";
  }

  async function clearKey(id: string) {
    await forgetAiKey(id);
    const ep = settings.ai.endpoints.find((e) => e.id === id);
    if (ep) ep.hasKey = false;
  }

  async function removeEndpoint(id: string) {
    await forgetAiKey(id);
    settings.ai.endpoints = settings.ai.endpoints.filter((e) => e.id !== id);
    if (settings.ai.activeEndpointId === id) {
      settings.ai.activeEndpointId = settings.ai.endpoints[0]?.id ?? null;
    }
    deleteId = null;
  }

  // Which endpoint cards are expanded. Default: the active one is open, the rest
  // collapse to a one-line summary (name · provider · model · status).
  let expandedOverride = $state<Record<string, boolean>>({});
  const isExpanded = (id: string): boolean => expandedOverride[id] ?? id === ai.activeEndpointId;
  const toggleExpanded = (id: string) => (expandedOverride[id] = !isExpanded(id));

  /** Connection status for the dot/label: checked-ok, checked-error, or unchecked. */
  function epStatus(id: string): "ok" | "error" | "none" {
    const r = checkResult[id];
    return r ? (r.ok ? "ok" : "error") : "none";
  }
  const statusDot = (id: string): string =>
    ({ ok: "bg-green-500", error: "bg-danger", none: "bg-muted" })[epStatus(id)];
  // Provider short name for the summary pill — a domain term, not translated.
  const providerShort = (p: AiProvider): string => (p === "anthropic" ? "Anthropic" : "OpenAI");

  const inputCls =
    "w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent";
</script>

<p class="mb-2 text-[11px] text-muted">{t("settings.aiNote")}</p>

<label class="mb-3 flex items-center gap-2 text-xs text-muted">
  <input type="checkbox" data-testid="ai-enabled" bind:checked={settings.ai.enabled} />
  {t("settings.aiEnabled")}
</label>

<!-- Endpoints -->
<div class="mb-2 text-[11px] uppercase tracking-wider text-muted">{t("settings.aiEndpoints")}</div>
{#if ai.endpoints.length === 0}
  <p class="mb-2 text-[11px] text-muted">{t("settings.aiNoEndpoints")}</p>
{/if}
<div class="space-y-2">
  {#each ai.endpoints as ep (ep.id)}
    {#if !isExpanded(ep.id)}
      <!-- Collapsed summary: name · provider · model · status. Click to expand. -->
      <button
        type="button"
        data-testid="ai-endpoint"
        class="flex w-full items-center gap-2 rounded border border-edge p-2 text-left hover:bg-edge"
        onclick={() => toggleExpanded(ep.id)}
      >
        <span class="h-2 w-2 shrink-0 rounded-full {statusDot(ep.id)}"></span>
        <span class="truncate text-sm text-white">{ep.name || t("settings.aiName")}</span>
        <span class="shrink-0 rounded-full bg-edge px-2 py-0.5 text-[10px] text-muted">
          {providerShort(ep.provider)}
        </span>
        <span class="truncate font-mono text-[11px] text-muted">{ep.model}</span>
        <span class="ml-auto"></span>
        {#if checkResult[ep.id]?.ok}
          <span class="shrink-0 text-[11px] text-muted">
            {t("settings.aiModelsCount", { count: String(checkResult[ep.id].models.length) })}
          </span>
        {/if}
        <Icon name="chevronDown" size={14} class="shrink-0 text-muted" />
      </button>
    {:else}
      <!-- Expanded editor: left-aligned labels; connection check at the bottom. -->
      <div class="overflow-hidden rounded border border-accent" data-testid="ai-endpoint">
        <div class="flex items-center gap-2 border-b border-edge bg-panel px-2 py-1.5">
          <span class="h-2 w-2 shrink-0 rounded-full {statusDot(ep.id)}"></span>
          <span class="truncate text-sm text-white">{ep.name || t("settings.aiName")}</span>
          <span class="shrink-0 rounded-full bg-edge px-2 py-0.5 text-[10px] text-muted">
            {providerShort(ep.provider)}
          </span>
          <span
            class="ml-auto shrink-0 text-[11px] {epStatus(ep.id) === 'ok'
              ? 'text-green-500'
              : epStatus(ep.id) === 'error'
                ? 'text-danger'
                : 'text-muted'}"
          >
            {epStatus(ep.id) === "ok"
              ? t("settings.aiConnected")
              : epStatus(ep.id) === "error"
                ? t("settings.aiCheckFailed")
                : t("settings.aiNotChecked")}
          </span>
          <button
            class="shrink-0 rounded p-1 text-muted hover:text-white"
            use:tooltip={t("settings.aiCollapse")}
            aria-label={t("settings.aiCollapse")}
            onclick={() => toggleExpanded(ep.id)}
          >
            <Icon name="chevronUp" size={14} />
          </button>
          <button
            class="shrink-0 rounded p-1 text-muted hover:text-danger"
            use:tooltip={t("common.delete")}
            aria-label={t("common.delete")}
            onclick={() => (deleteId = ep.id)}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>

        <div class="p-2">
          <div class="grid grid-cols-[76px_1fr] items-center gap-x-3 gap-y-2">
            <span class="text-[10px] text-muted">{t("settings.aiActive")}</span>
            <input
              type="radio"
              name="ai-active"
              class="justify-self-start"
              value={ep.id}
              checked={ai.activeEndpointId === ep.id}
              onchange={() => (settings.ai.activeEndpointId = ep.id)}
            />

            <span class="text-[10px] text-muted">{t("settings.aiName")}</span>
            <div class="flex gap-2">
              <input class="min-w-0 flex-1 {inputCls}" placeholder={t("settings.aiName")} bind:value={ep.name} />
              <select
                class="shrink-0 rounded border border-edge bg-panel px-1 py-1 text-xs text-white outline-none focus:border-accent"
                bind:value={ep.provider}
              >
                <option value="openai">{t("settings.aiProviderOpenai")}</option>
                <option value="anthropic">{t("settings.aiProviderAnthropic")}</option>
              </select>
            </div>

            <span class="text-[10px] text-muted">{t("settings.aiBaseUrl")}</span>
            <input class={inputCls} placeholder="http://localhost:11434/v1" bind:value={ep.baseUrl} />

            <span class="text-[10px] text-muted">{t("settings.aiModel")}</span>
            <div class="flex gap-2">
              {#if checkResult[ep.id]?.ok && checkResult[ep.id].models.length > 0}
                <select class="min-w-0 flex-1 {inputCls}" bind:value={ep.model}>
                  {#each mergeModelOptions(checkResult[ep.id].models, ep.model) as m (m)}
                    <option value={m}>{m}</option>
                  {/each}
                </select>
              {:else}
                <input class="min-w-0 flex-1 {inputCls}" placeholder="qwen2.5" bind:value={ep.model} />
              {/if}
              <button
                class="shrink-0 rounded bg-edge px-2 py-1 text-muted hover:bg-accent hover:text-panel-alt disabled:opacity-50"
                use:tooltip={t("ai.modelRefresh")}
                aria-label={t("ai.modelRefresh")}
                disabled={checking[ep.id]}
                onclick={() => checkConn(ep)}
              >
                <Icon name="refresh" size={13} />
              </button>
            </div>

            <span class="text-[10px] text-muted">{t("settings.aiKey")}</span>
            <div class="flex gap-2">
              <input
                type="password"
                class="min-w-0 flex-1 {inputCls}"
                placeholder={ep.hasKey ? "••••••••" : t("settings.aiKeyHint")}
                autocomplete="off"
                bind:value={keyDrafts[ep.id]}
              />
              <button
                class="shrink-0 rounded bg-edge px-2 py-1 text-[11px] hover:bg-accent hover:text-panel-alt"
                onclick={() => saveKey(ep.id)}>{t("settings.aiKeySave")}</button
              >
              {#if ep.hasKey}
                <button
                  class="shrink-0 rounded px-2 py-1 text-[11px] text-muted hover:text-danger"
                  onclick={() => clearKey(ep.id)}>{t("settings.aiKeyClear")}</button
                >
              {/if}
            </div>
          </div>

          <!-- Advanced: model-wide base prompt + extra params JSON (collapsible). -->
          <div class="mt-2 border-t border-edge pt-2">
            <DisclosureRow
              bind:open={advancedOpen[ep.id]}
              label={t("settings.aiAdvanced")}
              testid={`ai-advanced-${ep.id}`}
            />
            {#if advancedOpen[ep.id]}
              <div class="mt-2 space-y-2">
                <label class="block text-[10px] text-muted">
                  {t("settings.aiBasePrompt")}
                  <textarea
                    data-testid="ai-base-prompt"
                    rows="3"
                    class="mt-0.5 {inputCls} resize-y font-mono leading-relaxed"
                    bind:value={ep.basePrompt}
                  ></textarea>
                </label>
                <p class="text-[10px] text-muted">{t("settings.aiBasePromptHint")}</p>
                <label class="block border-t border-edge pt-2 text-[10px] text-muted">
                  {t("settings.aiParams")}
                  <textarea
                    data-testid="ai-params"
                    rows="3"
                    spellcheck="false"
                    placeholder={'{ "temperature": 0.2, "top_p": 0.9 }'}
                    class="mt-0.5 {inputCls} resize-y font-mono leading-relaxed"
                    bind:value={ep.params}
                  ></textarea>
                </label>
                {#if paramsInvalid(ep)}
                  <p class="text-[10px] text-danger" data-testid="ai-params-error">
                    {t("settings.aiParamsInvalid")}
                  </p>
                {:else}
                  <p class="text-[10px] text-muted">{t("settings.aiParamsHint")}</p>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Connection check + status — last, after the key is entered. -->
          <div class="mt-3 flex items-center gap-2 border-t border-edge pt-3">
            <button
              class="shrink-0 rounded bg-edge px-2 py-1 text-[11px] hover:bg-accent hover:text-panel-alt disabled:opacity-50"
              data-testid="ai-check"
              disabled={checking[ep.id]}
              onclick={() => checkConn(ep)}
            >
              {checking[ep.id] ? t("settings.aiChecking") : t("settings.aiCheck")}
            </button>
            {#if checkResult[ep.id]?.ok}
              <span class="flex items-center gap-1 text-[11px] text-green-500">
                <Icon name="check" size={12} />
                {t("settings.aiCheckOk", { count: String(checkResult[ep.id].models.length) })}
              </span>
            {:else if checkResult[ep.id]}
              <span class="truncate text-[11px] text-danger" title={checkResult[ep.id].error}>
                {checkResult[ep.id].error}
              </span>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  {/each}
</div>
<div class="mt-2 flex gap-2">
  <button
    class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-xs hover:bg-accent hover:text-panel-alt"
    data-testid="ai-add-local"
    onclick={() => addEndpoint("openai")}
  >
    <Icon name="plus" size={13} />
    {t("settings.aiAddLocal")}
  </button>
  <button
    class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-xs hover:bg-accent hover:text-panel-alt"
    onclick={() => addEndpoint("anthropic")}
  >
    <Icon name="plus" size={13} />
    {t("settings.aiAddCloud")}
  </button>
</div>

<!-- Output contract -->
<label class="mt-3 block text-xs text-muted">
  {t("settings.aiContract")}
  <select class="mt-1 {inputCls}" bind:value={settings.ai.contract}>
    <option value="markdown">{t("settings.aiContractMarkdown")}</option>
    <option value="tools">{t("settings.aiContractTools")}</option>
  </select>
</label>
<p class="mt-0.5 text-[10px] text-muted">{t("settings.aiContractHint")}</p>

<!-- Executor mode -->
<label class="mt-3 block text-xs text-muted">
  {t("settings.aiExecMode")}
  <select class="mt-1 {inputCls}" bind:value={settings.ai.execMode}>
    <option value="suggest">{t("settings.aiExecSuggest")}</option>
    <option value="confirm">{t("settings.aiExecConfirm")}</option>
    <option value="auto">{t("settings.aiExecAuto")}</option>
    <option value="dialogConfirm">{t("settings.aiExecDialogConfirm")}</option>
    <option value="dialog">{t("settings.aiExecDialog")}</option>
  </select>
</label>
<p class="mt-0.5 text-[10px] text-muted">{t("settings.aiExecHint")}</p>

<!-- Context tiers -->
<div class="mt-3 text-xs text-muted">{t("settings.aiContext")}</div>
<label class="mt-1 flex items-center gap-2 text-xs text-muted">
  <input type="checkbox" bind:checked={settings.ai.includeBuffer} />
  {t("settings.aiIncludeBuffer")}
</label>
<label class="mt-1 flex items-center gap-2 text-xs text-muted">
  <input type="checkbox" bind:checked={settings.ai.includeRecording} />
  {t("settings.aiIncludeRecording")}
</label>
<label class="mt-1 flex items-center gap-2 text-xs text-muted">
  <input type="checkbox" bind:checked={settings.ai.includeMetadata} />
  {t("settings.aiIncludeMetadata")}
</label>
<p class="mt-0.5 text-[10px] text-muted">{t("settings.aiContextHint")}</p>

<!-- System prompts — collapsible section; each kind is a collapsible list. -->
<div class="mt-3">
  <DisclosureRow bind:open={promptsOpen} label={t("settings.aiPrompts")} testid="ai-prompts" />
  {#if promptsOpen}
    <div class="mt-2 space-y-2 border-l border-edge pl-2">
      {#each AI_PROMPT_KINDS as kind (kind)}
        {@const set = settings.ai.prompts[kind]}
        <div>
          <DisclosureRow
            bind:open={kindOpen[kind]}
            label={kindLabel(kind)}
            count={set.prompts.length}
            testid={`ai-prompts-${kind}`}
          />
          {#if kindOpen[kind]}
            <div class="mt-1 space-y-2 pl-4">
              {#each set.prompts as p (p.id)}
                <div class="rounded border border-edge p-2" data-testid="ai-prompt">
                  <div class="mb-1 flex items-center gap-2">
                    <label
                      class="flex shrink-0 items-center gap-1 text-[10px] text-muted"
                      use:tooltip={t("settings.aiPromptActive")}
                    >
                      <input
                        type="radio"
                        name={`ai-prompt-active-${kind}`}
                        checked={set.activeId === p.id}
                        onchange={() => (set.activeId = p.id)}
                      />
                      {t("settings.aiPromptActive")}
                    </label>
                    <input
                      class="min-w-0 flex-1 {inputCls}"
                      placeholder={t("settings.aiPromptName")}
                      bind:value={p.name}
                    />
                    <button
                      class="shrink-0 rounded p-1 text-muted hover:text-white disabled:opacity-40"
                      use:tooltip={t("settings.aiPromptReset")}
                      aria-label={t("settings.aiPromptReset")}
                      disabled={p.content === DEFAULT_PROMPT[kind]}
                      onclick={() => (p.content = DEFAULT_PROMPT[kind])}
                    >
                      <Icon name="sync" size={13} />
                    </button>
                    <button
                      class="shrink-0 rounded p-1 text-muted hover:text-danger disabled:opacity-40"
                      use:tooltip={t("common.delete")}
                      aria-label={t("common.delete")}
                      disabled={set.prompts.length <= 1}
                      onclick={() => removePrompt(kind, p.id)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                  <textarea
                    data-testid="ai-prompt-content"
                    rows="4"
                    class="{inputCls} resize-y font-mono leading-relaxed"
                    bind:value={p.content}
                  ></textarea>
                </div>
              {/each}
              <button
                class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-[11px] hover:bg-accent hover:text-panel-alt"
                data-testid={`ai-prompt-add-${kind}`}
                onclick={() => addPrompt(kind)}
              >
                <Icon name="plus" size={12} />
                {t("settings.aiPromptAdd")}
              </button>
            </div>
          {/if}
        </div>
      {/each}
      <p class="text-[10px] text-muted">{t("settings.aiPromptsHint")}</p>
      <p class="text-[10px] text-muted">{t("settings.aiPromptsModelHint")}</p>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={!!deleteId}
  title={t("settings.aiDeleteTitle")}
  confirmLabel={t("common.delete")}
  danger
  onconfirm={() => deleteId && removeEndpoint(deleteId)}
  oncancel={() => (deleteId = null)}
>
  {t("settings.aiDeleteBody")}
</ConfirmDialog>
