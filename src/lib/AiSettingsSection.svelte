<script lang="ts">
  // AI assistant settings (Phase 17, opt-in). Master switch + endpoint management
  // (provider/baseUrl/model/key) + output contract, executor mode and context tiers.
  // API keys never live in settings — they go straight to the keychain via the
  // backend; here we only track the `hasKey` flag.
  import { settings } from "./settings.svelte";
  import {
    newAiEndpoint,
    DEFAULT_CHAT_SYSTEM,
    DEFAULT_RUNBOOK_SYSTEM,
    DEFAULT_SCRIPT_SH_SYSTEM,
    DEFAULT_SCRIPT_ANSIBLE_SYSTEM,
    type AiProvider,
  } from "./ai";
  import { setAiKey, forgetAiKey } from "./api";
  import Icon from "./Icon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { t } from "./i18n";

  // Transient API-key drafts — never persisted (keys live in the keychain).
  let keyDrafts = $state<Record<string, string>>({});
  let deleteId = $state<string | null>(null);

  const ai = $derived(settings.ai);

  function addEndpoint(provider: AiProvider) {
    const ep = newAiEndpoint(provider);
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
    <div class="rounded border border-edge p-2" data-testid="ai-endpoint">
      <div class="mb-1 flex items-center gap-2">
        <label class="flex items-center gap-1 text-[11px] text-muted" title={t("settings.aiActive")}>
          <input
            type="radio"
            name="ai-active"
            value={ep.id}
            checked={ai.activeEndpointId === ep.id}
            onchange={() => (settings.ai.activeEndpointId = ep.id)}
          />
          {t("settings.aiActive")}
        </label>
        <input class="min-w-0 flex-1 {inputCls}" placeholder={t("settings.aiName")} bind:value={ep.name} />
        <select
          class="shrink-0 rounded border border-edge bg-panel px-1 py-1 text-xs text-white outline-none focus:border-accent"
          bind:value={ep.provider}
        >
          <option value="openai">{t("settings.aiProviderOpenai")}</option>
          <option value="anthropic">{t("settings.aiProviderAnthropic")}</option>
        </select>
        <button
          class="shrink-0 rounded p-1 text-muted hover:text-danger"
          title={t("common.delete")}
          aria-label={t("common.delete")}
          onclick={() => (deleteId = ep.id)}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <label class="mb-1 block text-[10px] text-muted">
        {t("settings.aiBaseUrl")}
        <input class="mt-0.5 {inputCls}" placeholder="http://localhost:11434/v1" bind:value={ep.baseUrl} />
      </label>
      <label class="mb-1 block text-[10px] text-muted">
        {t("settings.aiModel")}
        <input class="mt-0.5 {inputCls}" placeholder="qwen2.5" bind:value={ep.model} />
      </label>
      <div class="text-[10px] text-muted">{t("settings.aiKey")} ({t("settings.aiKeyHint")})</div>
      <div class="mt-0.5 flex items-center gap-2">
        <input
          type="password"
          class="min-w-0 flex-1 {inputCls}"
          placeholder={ep.hasKey ? "••••••••" : ""}
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

<!-- System prompts (editable) -->
<div class="mt-3 text-xs text-muted">{t("settings.aiPrompts")}</div>
<div class="mt-1">
  <div class="flex items-center justify-between">
    <label for="ai-chat-prompt" class="text-[10px] text-muted">{t("settings.aiChatPrompt")}</label>
    <button
      class="rounded px-1.5 py-0.5 text-[10px] text-muted hover:text-white disabled:opacity-40"
      disabled={settings.ai.chatSystem === DEFAULT_CHAT_SYSTEM}
      onclick={() => (settings.ai.chatSystem = DEFAULT_CHAT_SYSTEM)}
    >
      {t("settings.aiPromptReset")}
    </button>
  </div>
  <textarea
    id="ai-chat-prompt"
    data-testid="ai-chat-prompt"
    rows="4"
    class="mt-0.5 {inputCls} resize-y font-mono leading-relaxed"
    bind:value={settings.ai.chatSystem}
  ></textarea>
</div>
<div class="mt-2">
  <div class="flex items-center justify-between">
    <label for="ai-runbook-prompt" class="text-[10px] text-muted">
      {t("settings.aiRunbookPrompt")}
    </label>
    <button
      class="rounded px-1.5 py-0.5 text-[10px] text-muted hover:text-white disabled:opacity-40"
      disabled={settings.ai.runbookSystem === DEFAULT_RUNBOOK_SYSTEM}
      onclick={() => (settings.ai.runbookSystem = DEFAULT_RUNBOOK_SYSTEM)}
    >
      {t("settings.aiPromptReset")}
    </button>
  </div>
  <textarea
    id="ai-runbook-prompt"
    data-testid="ai-runbook-prompt"
    rows="4"
    class="mt-0.5 {inputCls} resize-y font-mono leading-relaxed"
    bind:value={settings.ai.runbookSystem}
  ></textarea>
</div>
<div class="mt-2">
  <div class="flex items-center justify-between">
    <label for="ai-sh-prompt" class="text-[10px] text-muted">{t("settings.aiScriptShPrompt")}</label>
    <button
      class="rounded px-1.5 py-0.5 text-[10px] text-muted hover:text-white disabled:opacity-40"
      disabled={settings.ai.scriptShSystem === DEFAULT_SCRIPT_SH_SYSTEM}
      onclick={() => (settings.ai.scriptShSystem = DEFAULT_SCRIPT_SH_SYSTEM)}
    >
      {t("settings.aiPromptReset")}
    </button>
  </div>
  <textarea
    id="ai-sh-prompt"
    data-testid="ai-sh-prompt"
    rows="4"
    class="mt-0.5 {inputCls} resize-y font-mono leading-relaxed"
    bind:value={settings.ai.scriptShSystem}
  ></textarea>
</div>
<div class="mt-2">
  <div class="flex items-center justify-between">
    <label for="ai-ansible-prompt" class="text-[10px] text-muted">
      {t("settings.aiScriptAnsiblePrompt")}
    </label>
    <button
      class="rounded px-1.5 py-0.5 text-[10px] text-muted hover:text-white disabled:opacity-40"
      disabled={settings.ai.scriptAnsibleSystem === DEFAULT_SCRIPT_ANSIBLE_SYSTEM}
      onclick={() => (settings.ai.scriptAnsibleSystem = DEFAULT_SCRIPT_ANSIBLE_SYSTEM)}
    >
      {t("settings.aiPromptReset")}
    </button>
  </div>
  <textarea
    id="ai-ansible-prompt"
    data-testid="ai-ansible-prompt"
    rows="4"
    class="mt-0.5 {inputCls} resize-y font-mono leading-relaxed"
    bind:value={settings.ai.scriptAnsibleSystem}
  ></textarea>
</div>
<p class="mt-0.5 text-[10px] text-muted">{t("settings.aiPromptsHint")}</p>

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
