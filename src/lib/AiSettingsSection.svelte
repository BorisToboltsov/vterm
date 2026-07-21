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
    sanitizeOptionalInt,
    MAX_TOKENS_RANGE,
    TIMEOUT_RANGE,
    HISTORY_LIMIT_RANGE,
    HISTORY_CHAR_CAP_RANGE,
    defaultPrompt,
    resolvePromptContent,
    AI_PROMPT_KINDS,
    type AiProvider,
    type AiPromptKind,
    type AiEndpoint,
  } from "./ai";
  import { AI_PRESETS, endpointFromPreset, type AiPreset } from "./aipresets";
  import { buildPromptLayers, resolveReplyLanguage } from "./aicore";
  import ContextMenu from "./ContextMenu.svelte";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import { setAiKey, forgetAiKey, aiModels } from "./api";
  import { describeAiError } from "./aierror";
  import { BUILTIN_DANGEROUS_LABELS } from "./aidialog";
  import { MAX_DANGEROUS_PATTERNS } from "./ai";
  import DisclosureRow from "./DisclosureRow.svelte";
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import PasswordInput from "./PasswordInput.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { t, availableLocales } from "./i18n";
  import type { MessageKey } from "./i18n/messages";

  // Collapsible prompt sections (whole section + per kind).
  let promptsOpen = $state(false);
  let coreOpen = $state(false);

  /**
   * The system prompt as it would actually be sent, in its layers.
   *
   * Shown as separate labelled blocks because the core is English while the
   * persona follows the interface language — as one wall of text the switch reads
   * as a mistake rather than as two authors. Concatenating the blocks in order
   * reproduces exactly what is sent (asserted in aicore.test.ts).
   *
   * The facts are a representative session (SSH, execution on, not production);
   * the hint says the wording adapts, and showing the production paragraph here
   * would be misleading on an ordinary server.
   */
  const promptLayers = $derived(
    buildPromptLayers(
      resolvePromptContent(settings.ai.prompts.chat, null, defaultPrompt("chat")),
      {
        kind: "ssh",
        canExecute: settings.ai.execMode !== "suggest",
        execMode: settings.ai.execMode,
        prod: false,
        hasContext: true,
        replyLanguage: resolveReplyLanguage(settings.ai.replyLanguage, settings.language),
      },
      {},
    ),
  );

  // Custom "always confirm" command patterns (additive to the built-in list).
  let dangerOpen = $state(false);
  let patternDraft = $state("");
  function addPattern() {
    const p = patternDraft.trim();
    if (!p) return;
    const list = settings.ai.dangerousPatterns;
    if (list.length >= MAX_DANGEROUS_PATTERNS) return;
    if (list.some((x) => x.toLowerCase() === p.toLowerCase())) {
      patternDraft = "";
      return;
    }
    settings.ai.dangerousPatterns = [...list, p];
    patternDraft = "";
  }
  function removePattern(p: string) {
    settings.ai.dangerousPatterns = settings.ai.dangerousPatterns.filter((x) => x !== p);
    deletePattern = null;
  }
  // Seeded from the registry so adding a kind doesn't need a literal here.
  let kindOpen = $state<Record<AiPromptKind, boolean>>(
    Object.fromEntries(AI_PROMPT_KINDS.map((k) => [k, false])) as Record<AiPromptKind, boolean>,
  );
  const KIND_LABEL: Record<AiPromptKind, MessageKey> = {
    chat: "settings.aiChatPrompt",
    runbook: "settings.aiRunbookPrompt",
    sh: "settings.aiScriptShPrompt",
    ansible: "settings.aiScriptAnsiblePrompt",
    postmortem: "settings.aiPostmortemPrompt",
    commit: "settings.aiCommitPrompt",
  };
  function kindLabel(k: AiPromptKind): string {
    return t(KIND_LABEL[k]);
  }

  /** The preview blocks, in the order they are concatenated when sent. */
  function promptLayerRows() {
    return [
      { key: "core", label: t("settings.aiLayerCore"), text: promptLayers.core },
      { key: "persona", label: t("settings.aiLayerPersona"), text: promptLayers.persona },
      { key: "reply", label: t("settings.aiReplyLanguage"), text: promptLayers.reply },
    ];
  }

  /** Restore the shipped text and mark the prompt untouched again, so a later
   *  interface-language change re-seeds it (see `reseedBuiltinPrompts`). */
  function resetPrompt(p: { content: string; origin?: "builtin" | "custom" }, kind: AiPromptKind) {
    p.content = defaultPrompt(kind);
    p.origin = "builtin";
  }

  /** Any edit makes the prompt the user's — it is never re-seeded after this. */
  function markCustom(p: { origin?: "builtin" | "custom" }) {
    p.origin = "custom";
  }

  function addPrompt(kind: AiPromptKind) {
    const set = settings.ai.prompts[kind];
    const p = newAiPrompt(kind, t("settings.aiPromptNewName"));
    set.prompts = [...set.prompts, p];
    set.activeId = set.activeId ?? p.id;
  }
  function removePrompt(kind: AiPromptKind, id: string) {
    const set = settings.ai.prompts[kind];
    deletePromptTarget = null;
    if (set.prompts.length <= 1) return;
    set.prompts = set.prompts.filter((p) => p.id !== id);
    if (set.activeId === id) set.activeId = set.prompts[0]?.id ?? null;
  }

  // Transient API-key drafts — never persisted (keys live in the keychain).
  let keyDrafts = $state<Record<string, string>>({});
  let deleteId = $state<string | null>(null);
  let clearKeyId = $state<string | null>(null);
  let deletePattern = $state<string | null>(null);
  let deletePromptTarget = $state<{ kind: AiPromptKind; id: string } | null>(null);
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

  function addEndpoint(ep: AiEndpoint) {
    advancedOpen[ep.id] = false; // seed before it renders (bind:open needs a boolean)
    settings.ai.endpoints = [...settings.ai.endpoints, ep];
    if (!settings.ai.activeEndpointId) settings.ai.activeEndpointId = ep.id;
  }

  // "Add endpoint" menu (Phase 40). Built on the shared ContextMenu primitive
  // rather than a bespoke popup, per the components invariant; presets come from
  // the pure registry, so a new vendor is a data entry, not UI work.
  let addMenu = $state<OpenMenu | null>(null);

  function presetRow(p: AiPreset): MenuItem {
    return { label: p.label, onSelect: () => addEndpoint(endpointFromPreset(p)) };
  }

  function openAddMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = AI_PRESETS.filter((p) => p.kind === "local").map(presetRow);
    const cloud = AI_PRESETS.filter((p) => p.kind === "cloud").map(presetRow);
    addMenu = {
      x: r.left,
      y: r.bottom + 4,
      items: [
        ...local,
        { kind: "separator" },
        ...cloud,
        { kind: "separator" },
        {
          label: t("settings.aiAddCustom"),
          icon: "settings",
          onSelect: () => addEndpoint(newAiEndpoint("openai")),
        },
      ],
    };
  }

  /** Write a bounded numeric endpoint field, treating a blank box as "default". */
  function setNumField(
    ep: AiEndpoint,
    field: "maxTokens" | "timeoutSec",
    raw: string,
    range: { min: number; max: number },
  ) {
    ep[field] = raw.trim() ? sanitizeOptionalInt(raw, range) : null;
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
    clearKeyId = null;
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
    ({ ok: "bg-ok", error: "bg-danger", none: "bg-muted" })[epStatus(id)];
  // Provider short name for the summary pill — a domain term, not translated.
  const providerShort = (p: AiProvider): string => (p === "anthropic" ? "Anthropic" : "OpenAI");

  const inputCls =
    "w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-text outline-none focus:border-accent";
</script>

<section>
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionAi")}<InfoHint text={t("settings.aiNote")} />
  </h3>

<label class="mb-3 flex items-center gap-2 text-xs text-muted">
  <input type="checkbox" data-testid="ai-enabled" bind:checked={settings.ai.enabled} />
  {t("settings.aiEnabled")}
</label>

<!-- Endpoints -->
<div class="mb-2 text-caption uppercase tracking-wider text-muted">{t("settings.aiEndpoints")}</div>
{#if ai.endpoints.length === 0}
  <p class="mb-2 text-meta text-muted">{t("settings.aiNoEndpoints")}</p>
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
        <span class="truncate text-sm text-text">{ep.name || t("settings.aiName")}</span>
        <span class="shrink-0 rounded-full bg-edge px-2 py-0.5 text-caption text-muted">
          {providerShort(ep.provider)}
        </span>
        <span class="truncate font-mono text-meta text-muted">{ep.model}</span>
        <span class="ml-auto"></span>
        {#if checkResult[ep.id]?.ok}
          <span class="shrink-0 text-meta text-muted">
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
          <span class="truncate text-sm text-text">{ep.name || t("settings.aiName")}</span>
          <span class="shrink-0 rounded-full bg-edge px-2 py-0.5 text-caption text-muted">
            {providerShort(ep.provider)}
          </span>
          <span
            class="ml-auto shrink-0 text-meta {epStatus(ep.id) === 'ok'
              ? 'text-ok'
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
            class="shrink-0 rounded p-1 text-muted hover:text-text"
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
            <span class="text-caption text-muted">{t("settings.aiActive")}</span>
            <input
              type="radio"
              name="ai-active"
              class="justify-self-start"
              value={ep.id}
              checked={ai.activeEndpointId === ep.id}
              onchange={() => (settings.ai.activeEndpointId = ep.id)}
            />

            <span class="text-caption text-muted">{t("settings.aiName")}</span>
            <div class="flex gap-2">
              <input class="min-w-0 flex-1 {inputCls}" placeholder={t("settings.aiName")} bind:value={ep.name} />
              <select
                class="shrink-0 rounded border border-edge bg-panel px-1 py-1 text-xs text-text outline-none focus:border-accent"
                bind:value={ep.provider}
              >
                <option value="openai">{t("settings.aiProviderOpenai")}</option>
                <option value="anthropic">{t("settings.aiProviderAnthropic")}</option>
              </select>
            </div>

            <span class="text-caption text-muted">{t("settings.aiBaseUrl")}</span>
            <input class={inputCls} placeholder="http://localhost:11434/v1" bind:value={ep.baseUrl} />

            <span class="text-caption text-muted">{t("settings.aiModel")}</span>
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

            <span class="text-caption text-muted">{t("settings.aiKey")}</span>
            <div class="flex gap-2">
              <PasswordInput
                class="min-w-0 flex-1"
                inputClass={inputCls}
                placeholder={ep.hasKey ? "••••••••" : t("settings.aiKeyHint")}
                bind:value={keyDrafts[ep.id]}
              />
              <button
                class="shrink-0 rounded bg-edge px-2 py-1 text-meta hover:bg-accent hover:text-panel-alt"
                onclick={() => saveKey(ep.id)}>{t("settings.aiKeySave")}</button
              >
              {#if ep.hasKey}
                <button
                  class="shrink-0 rounded px-2 py-1 text-meta text-muted hover:text-danger"
                  onclick={() => (clearKeyId = ep.id)}>{t("settings.aiKeyClear")}</button
                >
              {/if}
            </div>

            <!-- Reply cap + request timeout (Phase 40). Blank = the endpoint's
                 own default, so an untouched endpoint behaves exactly as before. -->
            <span class="text-caption text-muted">{t("settings.aiMaxTokens")}</span>
            <div class="flex items-center gap-2">
              <input
                type="number"
                data-testid={`ai-max-tokens-${ep.id}`}
                class="w-24 {inputCls}"
                min={MAX_TOKENS_RANGE.min}
                max={MAX_TOKENS_RANGE.max}
                placeholder={t("settings.aiAuto")}
                value={ep.maxTokens ?? ""}
                onchange={(e) => setNumField(ep, "maxTokens", e.currentTarget.value, MAX_TOKENS_RANGE)}
              />
              <span class="text-caption text-muted">{t("settings.aiMaxTokensHint")}</span>
            </div>

            <span class="text-caption text-muted">{t("settings.aiTimeout")}</span>
            <div class="flex items-center gap-2">
              <input
                type="number"
                data-testid={`ai-timeout-${ep.id}`}
                class="w-24 {inputCls}"
                min={TIMEOUT_RANGE.min}
                max={TIMEOUT_RANGE.max}
                placeholder={t("settings.aiAuto")}
                value={ep.timeoutSec ?? ""}
                onchange={(e) => setNumField(ep, "timeoutSec", e.currentTarget.value, TIMEOUT_RANGE)}
              />
              <span class="text-caption text-muted">{t("settings.aiTimeoutHint")}</span>
            </div>
          </div>

          <!-- Advanced: model-wide base prompt + extra params JSON (collapsible). -->
          <div class="mt-2">
            <DisclosureRow
              variant="list"
              bind:open={advancedOpen[ep.id]}
              label={t("settings.aiAdvanced")}
              testid={`ai-advanced-${ep.id}`}
            />
            {#if advancedOpen[ep.id]}
              <div class="mt-2 space-y-2">
                <label class="block text-caption text-muted">
                  <span class="flex items-center gap-1"
                    >{t("settings.aiBasePrompt")}<InfoHint text={t("settings.aiBasePromptHint")} /></span
                  >
                  <textarea
                    data-testid="ai-base-prompt"
                    rows="3"
                    class="mt-0.5 {inputCls} resize-y font-mono leading-relaxed"
                    bind:value={ep.basePrompt}
                  ></textarea>
                </label>
                <label class="block border-t border-edge pt-2 text-caption text-muted">
                  <span class="flex items-center gap-1"
                    >{t("settings.aiParams")}<InfoHint text={t("settings.aiParamsHint")} /></span
                  >
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
                  <p class="text-caption text-danger" data-testid="ai-params-error">
                    {t("settings.aiParamsInvalid")}
                  </p>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Connection check + status — last, after the key is entered. -->
          <div class="mt-3 flex items-center gap-2 border-t border-edge pt-3">
            <button
              class="shrink-0 rounded bg-edge px-2 py-1 text-meta hover:bg-accent hover:text-panel-alt disabled:opacity-50"
              data-testid="ai-check"
              disabled={checking[ep.id]}
              onclick={() => checkConn(ep)}
            >
              {checking[ep.id] ? t("settings.aiChecking") : t("settings.aiCheck")}
            </button>
            {#if checkResult[ep.id]?.ok}
              <span class="flex items-center gap-1 text-meta text-ok">
                <Icon name="check" size={12} />
                {t("settings.aiCheckOk", { count: String(checkResult[ep.id].models.length) })}
              </span>
            {:else if checkResult[ep.id]}
              <span class="truncate text-meta text-danger" title={checkResult[ep.id].error}>
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
    data-testid="ai-add-endpoint"
    onclick={openAddMenu}
  >
    <Icon name="plus" size={13} />
    {t("settings.aiAddEndpoint")}
    <Icon name="chevronDown" size={13} />
  </button>
</div>
<ContextMenu menu={addMenu} onclose={() => (addMenu = null)} />

<!-- Output contract -->
<label class="mt-3 block text-xs text-muted">
  <span class="flex items-center gap-1"
    >{t("settings.aiContract")}<InfoHint text={t("settings.aiContractHint")} /></span
  >
  <select class="mt-1 {inputCls}" bind:value={settings.ai.contract}>
    <option value="markdown">{t("settings.aiContractMarkdown")}</option>
    <option value="tools">{t("settings.aiContractTools")}</option>
  </select>
</label>

<!-- Executor mode -->
<label class="mt-3 block text-xs text-muted">
  <span class="flex items-center gap-1"
    >{t("settings.aiExecMode")}<InfoHint text={t("settings.aiExecHint")} /></span
  >
  <select class="mt-1 {inputCls}" bind:value={settings.ai.execMode}>
    <option value="suggest">{t("settings.aiExecSuggest")}</option>
    <option value="confirm">{t("settings.aiExecConfirm")}</option>
    <option value="dialogConfirm">{t("settings.aiExecDialogConfirm")}</option>
    <option value="dialog">{t("settings.aiExecDialog")}</option>
  </select>
</label>

<!-- Commands that always require confirmation — built-in list (read-only) plus
     the user's own additive patterns. Collapsible. -->
<div class="mt-3">
  <DisclosureRow
    variant="list"
    bind:open={dangerOpen}
    label={t("settings.aiDanger")}
    count={settings.ai.dangerousPatterns.length}
    testid="ai-danger"
  >
    {#snippet trailing()}<InfoHint text={t("settings.aiDangerHint")} />{/snippet}
  </DisclosureRow>
  {#if dangerOpen}
    <div class="mt-2 space-y-3 border-l border-edge pl-2">
      <div>
        <div class="mb-1 text-caption uppercase tracking-wider text-muted">
          {t("settings.aiDangerBuiltin")}
        </div>
        <div class="flex flex-wrap gap-1.5">
          {#each BUILTIN_DANGEROUS_LABELS as label (label)}
            <span
              class="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-meta text-accent"
              >{label}</span
            >
          {/each}
        </div>
      </div>
      <div>
        <div class="mb-1 text-caption uppercase tracking-wider text-muted">
          {t("settings.aiDangerCustom")}
        </div>
        {#if settings.ai.dangerousPatterns.length > 0}
          <div class="mb-2 space-y-1">
            {#each settings.ai.dangerousPatterns as p (p)}
              <div class="flex items-center gap-2" data-testid="ai-danger-item">
                <span class="min-w-0 flex-1 truncate font-mono text-meta text-text">{p}</span>
                <button
                  class="shrink-0 rounded p-1 text-muted hover:text-danger"
                  use:tooltip={t("common.delete")}
                  aria-label={t("common.delete")}
                  onclick={() => (deletePattern = p)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            {/each}
          </div>
        {/if}
        <div class="flex gap-2">
          <input
            class="min-w-0 flex-1 {inputCls}"
            data-testid="ai-danger-input"
            placeholder={t("settings.aiDangerPlaceholder")}
            bind:value={patternDraft}
            onkeydown={(e) => e.key === "Enter" && (e.preventDefault(), addPattern())}
          />
          <button
            class="flex shrink-0 items-center gap-1 rounded bg-edge px-2 py-1 text-meta hover:bg-accent hover:text-panel-alt disabled:opacity-40"
            data-testid="ai-danger-add"
            disabled={!patternDraft.trim() ||
              settings.ai.dangerousPatterns.length >= MAX_DANGEROUS_PATTERNS}
            onclick={addPattern}
          >
            <Icon name="plus" size={12} />
            {t("settings.aiDangerAdd")}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<!-- Context tiers -->
<div class="mt-3 flex items-center gap-1 text-xs text-muted">
  {t("settings.aiContext")}<InfoHint text={t("settings.aiContextHint")} />
</div>
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

<!-- History caps (Phase 40). Before this, every turn replayed the whole
     conversation — with context attached to each step of a dialog loop the
     request grew without bound, in tokens the user pays for. -->
<div class="mt-3 flex items-center gap-1 text-xs text-muted">
  {t("settings.aiHistory")}<InfoHint text={t("settings.aiHistoryHint")} />
</div>
<div class="mt-1 grid grid-cols-[96px_1fr] items-center gap-x-3 gap-y-2">
  <span class="text-caption text-muted">{t("settings.aiHistoryLimit")}</span>
  <div class="flex items-center gap-2">
    <input
      type="number"
      data-testid="ai-history-limit"
      class="w-24 {inputCls}"
      min={HISTORY_LIMIT_RANGE.min}
      max={HISTORY_LIMIT_RANGE.max}
      placeholder={t("settings.aiUnlimited")}
      value={settings.ai.historyLimit ?? ""}
      onchange={(e) =>
        (settings.ai.historyLimit = e.currentTarget.value.trim()
          ? sanitizeOptionalInt(e.currentTarget.value, HISTORY_LIMIT_RANGE)
          : null)}
    />
    <span class="text-caption text-muted">{t("settings.aiHistoryLimitHint")}</span>
  </div>

  <span class="text-caption text-muted">{t("settings.aiHistoryCap")}</span>
  <div class="flex items-center gap-2">
    <input
      type="number"
      data-testid="ai-history-cap"
      class="w-24 {inputCls}"
      min={HISTORY_CHAR_CAP_RANGE.min}
      max={HISTORY_CHAR_CAP_RANGE.max}
      placeholder={t("settings.aiUnlimited")}
      value={settings.ai.historyCharCap ?? ""}
      onchange={(e) =>
        (settings.ai.historyCharCap = e.currentTarget.value.trim()
          ? sanitizeOptionalInt(e.currentTarget.value, HISTORY_CHAR_CAP_RANGE)
          : null)}
    />
    <span class="text-caption text-muted">{t("settings.aiHistoryCapHint")}</span>
  </div>
</div>

<!-- System prompts — collapsible section; each kind is a collapsible list. -->
<div class="mt-3">
  <DisclosureRow variant="list" bind:open={promptsOpen} label={t("settings.aiPrompts")} testid="ai-prompts">
    {#snippet trailing()}<InfoHint
        text={t("settings.aiPromptsHint") + "\n\n" + t("settings.aiPromptsModelHint")}
      />{/snippet}
  </DisclosureRow>
  {#if promptsOpen}
    <div class="mt-2 space-y-2 border-l border-edge pl-2">
      <!-- Reply language + the non-editable core, shown before the editable
           prompts so it is clear what they are added to. -->
      <label class="block text-meta text-muted">
        <span class="flex items-center gap-1">
          {t("settings.aiReplyLanguage")}<InfoHint text={t("settings.aiReplyLanguageHint")} />
        </span>
        <select
          data-testid="ai-reply-language"
          class="mt-1 {inputCls}"
          bind:value={settings.ai.replyLanguage}
        >
          <option value="auto">{t("settings.aiReplyLanguageAuto")}</option>
          {#each availableLocales as l (l.id)}
            <option value={l.id}>{l.nativeName}</option>
          {/each}
        </select>
      </label>

      <div>
        <DisclosureRow
          variant="list"
          bind:open={coreOpen}
          label={t("settings.aiEffectivePrompt")}
          testid="ai-core-prompt"
        >
          {#snippet trailing()}<InfoHint
              text={t("settings.aiCorePromptHint") + "\n\n" + t("settings.aiEffectivePromptHint")}
            />{/snippet}
        </DisclosureRow>
        {#if coreOpen}
          <!-- Read-only: this is exactly what is sent, so nothing reaches the
               model that the user cannot see here. -->
          <div class="mt-1 space-y-1.5" data-testid="ai-core-prompt-text">
            {#each promptLayerRows() as layer (layer.key)}
              {#if layer.text}
                <div>
                  <div class="mb-0.5 flex items-center gap-1 text-caption text-muted">
                    <span class="h-px w-2 bg-edge"></span>{layer.label}
                  </div>
                  <pre
                    class="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-edge bg-panel-alt p-2 font-mono text-caption leading-relaxed {layer.key ===
                    'persona'
                      ? 'text-text'
                      : 'text-muted'}">{layer.text}</pre>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      {#each AI_PROMPT_KINDS as kind (kind)}
        {@const set = settings.ai.prompts[kind]}
        <div>
          <DisclosureRow
            variant="list"
            bind:open={kindOpen[kind]}
            label={kindLabel(kind)}
            count={set.prompts.length}
            testid={`ai-prompts-${kind}`}
          >
            {#snippet trailing()}
              {#if kind !== "chat"}
                <InfoHint text={t("settings.aiGenPromptHint")} />
              {/if}
            {/snippet}
          </DisclosureRow>
          {#if kindOpen[kind]}
            <div class="mt-1 space-y-2 pl-4">
              {#each set.prompts as p (p.id)}
                <div class="rounded border border-edge p-2" data-testid="ai-prompt">
                  <div class="mb-1 flex items-center gap-2">
                    <label
                      class="flex shrink-0 items-center gap-1 text-caption text-muted"
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
                      class="shrink-0 rounded p-1 text-muted hover:text-text disabled:opacity-40"
                      use:tooltip={t("settings.aiPromptReset")}
                      aria-label={t("settings.aiPromptReset")}
                      disabled={p.content === defaultPrompt(kind)}
                      onclick={() => resetPrompt(p, kind)}
                    >
                      <Icon name="sync" size={13} />
                    </button>
                    <button
                      class="shrink-0 rounded p-1 text-muted hover:text-danger disabled:opacity-40"
                      use:tooltip={t("common.delete")}
                      aria-label={t("common.delete")}
                      disabled={set.prompts.length <= 1}
                      onclick={() => (deletePromptTarget = { kind, id: p.id })}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                  <textarea
                    data-testid="ai-prompt-content"
                    rows="4"
                    class="{inputCls} resize-y font-mono leading-relaxed"
                    bind:value={p.content}
                    oninput={() => markCustom(p)}
                  ></textarea>
                </div>
              {/each}
              <button
                class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-meta hover:bg-accent hover:text-panel-alt"
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
    </div>
  {/if}
</div>
</section>

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

<ConfirmDialog
  open={!!clearKeyId}
  title={t("settings.aiKeyClearTitle")}
  confirmLabel={t("settings.aiKeyClear")}
  danger
  onconfirm={() => clearKeyId && clearKey(clearKeyId)}
  oncancel={() => (clearKeyId = null)}
>
  {t("settings.aiKeyClearBody")}
</ConfirmDialog>

<ConfirmDialog
  open={!!deletePattern}
  title={t("settings.aiDangerRemoveTitle")}
  confirmLabel={t("common.delete")}
  danger
  onconfirm={() => deletePattern && removePattern(deletePattern)}
  oncancel={() => (deletePattern = null)}
>
  {t("settings.aiDangerRemoveBody", { pattern: deletePattern ?? "" })}
</ConfirmDialog>

<ConfirmDialog
  open={!!deletePromptTarget}
  title={t("settings.aiPromptDeleteTitle")}
  confirmLabel={t("common.delete")}
  danger
  onconfirm={() => deletePromptTarget && removePrompt(deletePromptTarget.kind, deletePromptTarget.id)}
  oncancel={() => (deletePromptTarget = null)}
>
  {t("settings.aiPromptDeleteBody")}
</ConfirmDialog>
