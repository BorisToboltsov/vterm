<script lang="ts">
  // AI chat content (Phase 17.2 + 17.3). Renders inside the shared right dock
  // (RightDock) as the "AI" tab — no own collapse/width chrome. Streams the
  // model's reply over `ai://out|done|error/{streamId}`; the HTTP lives in the
  // Rust broker (ai.rs). Phase 17.3 adds opt-in session context: when "attach
  // context" is on, the terminal selection / buffer / recording / metadata
  // (per AI settings tiers) are collected, redacted, and shown in a consent
  // dialog before anything is sent.
  import { tick } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import { settings } from "./settings.svelte";
  import {
    aiReady,
    activeEndpoint,
    mergeModelOptions,
    resolvePromptContent,
    effectiveExecMode,
    DEFAULT_CHAT_SYSTEM,
    type AiExecMode,
  } from "./ai";
  import { buildContext, type RawContext, type BuiltContext } from "./aicontext";
  import { parseChatSegments } from "./aiexec";
  import { DIALOG_SYSTEM_SUFFIX } from "./aidialog";
  import { aiModels } from "./api";
  import { writeClipboard } from "./clipboard";
  import { notifySuccess } from "./stores/toasts.svelte";
  import {
    aiChatState,
    getChat,
    startChat,
    stopChat,
    runCommand,
    confirmDialogStep,
    skipDialogStep,
    clearChat as clearSessionChat,
    KEY_NONE,
    type SessionChat,
  } from "./stores/aichat.svelte";
  import { renderMarkdown } from "./markdown";
  import AiConsentDialog from "./AiConsentDialog.svelte";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";

  let {
    getContext,
    sessionId,
    chatPromptId = null,
    serverExecMode = null,
    prod = false,
    noAi = false,
  }: {
    /** Reads the live session context (impure); omitted when no session is active. */
    getContext?: () => Promise<RawContext> | RawContext;
    /** Active session for executing proposed commands (17.4); omitted = no executor. */
    sessionId?: string;
    /** The active server's chosen chat prompt id (overrides the active one). */
    chatPromptId?: string | null;
    /** Per-server execution-mode override, or null to use the global setting. */
    serverExecMode?: AiExecMode | null;
    /** The active server is prod-flagged — auto-run is barred (falls back to confirm). */
    prod?: boolean;
    /** The active server is `noAi`-flagged — block context attach + execution (17.7). */
    noAi?: boolean;
  } = $props();

  // The conversation + streaming live in a per-session store (stores/aichat), so
  // switching tabs preserves each tab's dialog AND a reply keeps arriving in the
  // background. The slot is ensured in an effect (writes belong in effects, not
  // deriveds); `chat` is a pure read with a stable empty fallback for the first
  // frame. All writes go through the store service.
  const EMPTY_CHAT: SessionChat = {
    messages: [],
    executed: {},
    streaming: false,
    error: null,
    dialogStep: 0,
    dialogRunning: false,
    pending: null,
    context: { includeBuffer: false, includeRecording: false, includeMetadata: false },
  };
  const sessionKey = $derived(sessionId ?? KEY_NONE);
  $effect(() => {
    getChat(sessionKey);
  });
  const chat = $derived(aiChatState.map[sessionKey] ?? EMPTY_CHAT);
  const messages = $derived(chat.messages);
  const executed = $derived(chat.executed);
  const streaming = $derived(chat.streaming);
  const error = $derived(chat.error);
  const pending = $derived(chat.pending); // a dialog command awaiting confirm/skip

  let input = $state("");
  let attach = $state(false);
  let showTiers = $state(false); // context-tier popover open
  let scrollEl = $state<HTMLElement>();
  // Pending consent: a built context awaiting the user's explicit go-ahead.
  let consent = $state<{ question: string; built: BuiltContext } | null>(null);

  const ready = $derived(aiReady(settings.ai));
  const endpoint = $derived(activeEndpoint(settings.ai));
  // A `noAi` server blocks attaching context and executing commands (17.7).
  const canAttach = $derived(ready && !!getContext && !noAi);
  // Count of extra context tiers on (base selection/tail is always included).
  const tierCount = $derived(
    (chat.context.includeBuffer ? 1 : 0) +
      (chat.context.includeRecording ? 1 : 0) +
      (chat.context.includeMetadata ? 1 : 0),
  );
  // Per-server override wins over the global execution mode (still gated by prod/noAi).
  const execMode = $derived(effectiveExecMode(serverExecMode, settings.ai.execMode));
  /** Commands can be executed at all (not "suggest only", live session, AI allowed). */
  const canExecute = $derived(ready && !!sessionId && execMode !== "suggest" && !noAi);

  // Model picker: fetched model list per endpoint, chosen right here in the chat.
  let models = $state<string[]>([]);
  let loadingModels = $state(false);
  let modelsFor: string | null = null; // guard: fetch once per endpoint
  const modelOptions = $derived(mergeModelOptions(models, endpoint?.model ?? ""));

  async function refreshModels() {
    if (!endpoint) return;
    loadingModels = true;
    try {
      models = await aiModels({
        endpointId: endpoint.id,
        provider: endpoint.provider,
        baseUrl: endpoint.baseUrl,
      });
    } catch {
      models = []; // keep the manually-entered model as the sole option
    } finally {
      loadingModels = false;
    }
  }

  // Fetch the model list once when the active endpoint becomes available/changes.
  $effect(() => {
    const id = endpoint?.id ?? null;
    if (ready && id && id !== modelsFor) {
      modelsFor = id;
      models = [];
      refreshModels();
    }
  });

  function setModel(m: string) {
    if (endpoint) endpoint.model = m;
  }

  async function scrollToBottom() {
    await tick();
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  // Keep pinned to the newest content as a reply streams in (while mounted).
  $effect(() => {
    messages.length;
    messages[messages.length - 1]?.content;
    scrollToBottom();
  });

  async function send() {
    const text = input.trim();
    if (!text || streaming || !ready || consent || pending) return;
    if (attach && getContext && !noAi) {
      let raw: RawContext = {};
      try {
        raw = await getContext();
      } catch {
        raw = {};
      }
      const built = buildContext(raw, chat.context);
      if (built.text) {
        consent = { question: text, built };
        return; // hold until the user confirms in the consent dialog
      }
    }
    doSend(text, "");
  }

  function confirmConsent() {
    if (!consent) return;
    const { question, built } = consent;
    consent = null;
    doSend(question, built.text);
  }

  function cancelConsent() {
    consent = null;
  }

  /** Hand off to the per-session streaming service (survives tab switches). */
  function doSend(question: string, context: string) {
    input = "";
    // In dialog modes, tell the model to run one step at a time and wait for output.
    const base = resolvePromptContent(settings.ai.prompts.chat, chatPromptId, DEFAULT_CHAT_SYSTEM);
    const dialog = execMode === "dialog" || execMode === "dialogConfirm";
    void startChat({
      sessionId,
      question,
      context,
      system: dialog ? base + DIALOG_SYSTEM_SUFFIX : base,
      settings: settings.ai,
      execMode,
      prod,
      noAi,
    });
  }

  function copyBlock(block: string) {
    writeClipboard(block);
    notifySuccess(t("ai.exec.copied"));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function clearChat() {
    clearSessionChat(sessionId);
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="ai-chat">
  <div class="flex items-center gap-2 border-b border-edge px-2 py-1">
    {#if ready && endpoint}
      <select
        data-testid="ai-model"
        class="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-white outline-none focus:border-accent"
        use:tooltip={t("ai.model")}
        value={endpoint.model}
        onchange={(e) => setModel(e.currentTarget.value)}
      >
        {#each modelOptions as m (m)}
          <option value={m}>{m}</option>
        {/each}
      </select>
      <button
        class="shrink-0 rounded p-1 text-muted hover:text-white disabled:opacity-50"
        use:tooltip={t("ai.modelRefresh")}
        aria-label={t("ai.modelRefresh")}
        disabled={loadingModels}
        onclick={refreshModels}
      >
        <Icon name="refresh" size={13} class={loadingModels ? "animate-spin" : ""} />
      </button>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <button
      class="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-white disabled:opacity-50"
      onclick={clearChat}
      disabled={messages.length === 0 || streaming}>{t("ai.clear")}</button
    >
  </div>

  {#if noAi && ready}
    <div
      class="flex items-center gap-1 border-b border-edge bg-panel px-2 py-1 text-[11px] text-muted"
      data-testid="ai-noai-banner"
    >
      <Icon name="lock" size={12} />
      {t("ai.noAiBanner")}
    </div>
  {/if}

  <div bind:this={scrollEl} class="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 text-xs">
    {#if !ready}
      <p class="py-6 text-center text-[11px] text-muted">{t("ai.disabledHint")}</p>
    {:else if messages.length === 0}
      <p class="py-6 text-center text-[11px] text-muted">{t("ai.empty")}</p>
    {/if}
    {#each messages as m, i (i)}
      <div class="rounded border border-edge p-2 {m.role === 'user' ? 'bg-panel' : ''}">
        <div class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
          <span>{m.role === "user" ? t("ai.you") : t("ai.assistant")}</span>
          {#if m.withContext}
            <span class="flex items-center gap-0.5 text-accent" use:tooltip={t("ai.context.attached")}>
              <Icon name="paperclip" size={10} />
            </span>
          {/if}
        </div>
        {#if m.role === "assistant"}
          {#each parseChatSegments(m.content) as seg, si (si)}
            {#if seg.kind === "text"}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <div class="markdown-preview">{@html renderMarkdown(seg.content)}</div>
            {:else}
              <div class="my-1 overflow-hidden rounded border border-edge" data-testid="ai-code">
                <div
                  class="flex items-center justify-between gap-2 border-b border-edge bg-panel px-2 py-0.5"
                >
                  <span class="text-[10px] uppercase tracking-wider text-muted">
                    {seg.lang || "code"}
                  </span>
                  <div class="flex items-center gap-1">
                    <button
                      class="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted hover:text-white"
                      aria-label={t("ai.exec.copy")} use:tooltip={t("ai.exec.copy")}
                      onclick={() => copyBlock(seg.content)}
                    >
                      <Icon name="copy" size={11} />
                    </button>
                    {#if seg.runnable && seg.closed && canExecute}
                      <button
                        data-testid="ai-run"
                        class="flex items-center gap-0.5 rounded bg-edge px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-panel-alt disabled:opacity-50"
                        disabled={streaming || executed[`${i}:${si}`]}
                        onclick={() => runCommand(sessionId, chat, `${i}:${si}`, seg.content, noAi)}
                      >
                        <Icon name="play" size={11} />
                        {executed[`${i}:${si}`] ? t("ai.exec.ran") : t("ai.exec.run")}
                      </button>
                    {/if}
                  </div>
                </div>
                <pre class="overflow-x-auto p-2 text-[11px] leading-relaxed text-white"><code
                    >{seg.content}</code
                  ></pre>
              </div>
            {/if}
          {/each}
        {:else}
          <div class="whitespace-pre-wrap break-words">{m.content}</div>
        {/if}
      </div>
    {/each}
    {#if error}
      <p class="text-[11px] text-danger" data-testid="ai-error">{error}</p>
    {/if}
  </div>

  {#if pending}
    <!-- Dialog step awaiting the user's go-ahead (dialogConfirm / dangerous cmd). -->
    <div class="border-t border-edge bg-panel px-2 py-2" data-testid="ai-pending">
      <div class="mb-1 text-[10px] uppercase tracking-wider text-muted">
        {t("ai.dialog.confirmTitle")}
      </div>
      <pre
        class="mb-1.5 overflow-x-auto rounded bg-panel-alt p-2 font-mono text-[11px] text-white">{pending.command}</pre>
      <div class="flex justify-end gap-2">
        <button
          data-testid="ai-dialog-skip"
          class="rounded px-2 py-1 text-[11px] text-muted hover:text-white"
          onclick={() => skipDialogStep(sessionId)}>{t("ai.dialog.skip")}</button
        >
        <button
          data-testid="ai-dialog-run"
          class="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] text-panel-alt hover:bg-accent-hover"
          onclick={() => confirmDialogStep(sessionId)}
        >
          <Icon name="play" size={12} />
          {t("ai.dialog.run")}
        </button>
      </div>
    </div>
  {/if}

  <div class="border-t border-edge p-2">
    <textarea
      data-testid="ai-input"
      rows="2"
      placeholder={ready ? t("ai.placeholder") : t("ai.disabledHint")}
      disabled={!ready || streaming || !!pending}
      class="w-full resize-none rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent disabled:opacity-50"
      bind:value={input}
      onkeydown={onKey}
    ></textarea>
    <div class="mt-1 flex items-center justify-between">
      <div class="relative flex items-center">
        <button
          data-testid="ai-attach"
          type="button"
          class="flex items-center gap-1 rounded-l px-1.5 py-1 text-[11px] disabled:opacity-40 {attach
            ? 'bg-edge text-accent'
            : 'text-muted hover:text-white'}"
          disabled={!canAttach}
          aria-pressed={attach}
          use:tooltip={t("ai.context.toggleHint")}
          onclick={() => (attach = !attach)}
        >
          <Icon name="paperclip" size={13} />
          {t("ai.context.attach")}{#if attach && tierCount > 0}&nbsp;· {tierCount}{/if}
        </button>
        <button
          data-testid="ai-tiers"
          type="button"
          class="rounded-r px-1 py-1 text-[11px] text-muted hover:text-white disabled:opacity-40"
          disabled={!canAttach}
          aria-label={t("ai.context.tiers")}
          use:tooltip={t("ai.context.tiers")}
          onclick={() => (showTiers = !showTiers)}
        >
          <Icon name={showTiers ? "chevronDown" : "chevronUp"} size={12} />
        </button>
        {#if showTiers}
          <button
            class="fixed inset-0 z-40 cursor-default"
            aria-hidden="true"
            tabindex="-1"
            onclick={() => (showTiers = false)}
          ></button>
          <div
            class="absolute bottom-full left-0 z-50 mb-1 w-60 rounded border border-edge bg-panel-alt p-2 text-[11px] shadow-lg"
            data-testid="ai-tiers-menu"
          >
            <p class="mb-1.5 text-[10px] text-muted">{t("ai.context.base")}</p>
            <label class="mb-1 flex items-center gap-2 text-muted">
              <input type="checkbox" bind:checked={chat.context.includeBuffer} />
              {t("settings.aiIncludeBuffer")}
            </label>
            <label class="mb-1 flex items-center gap-2 text-muted">
              <input type="checkbox" bind:checked={chat.context.includeRecording} />
              {t("settings.aiIncludeRecording")}
            </label>
            <label class="flex items-center gap-2 text-muted">
              <input type="checkbox" bind:checked={chat.context.includeMetadata} />
              {t("settings.aiIncludeMetadata")}
            </label>
          </div>
        {/if}
      </div>
      {#if streaming}
        <button
          data-testid="ai-stop"
          type="button"
          class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-xs hover:bg-danger hover:text-panel-alt"
          use:tooltip={t("ai.stop")}
          onclick={() => stopChat(sessionId)}
        >
          <Icon name="stop" size={12} />
          {t("ai.stop")}
        </button>
      {:else}
        <button
          data-testid="ai-send"
          class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-xs hover:bg-accent hover:text-panel-alt disabled:opacity-50"
          disabled={!ready || input.trim() === "" || !!pending}
          onclick={send}
        >
          <Icon name="arrowRight" size={13} />
          {t("ai.send")}
        </button>
      {/if}
    </div>
  </div>
</div>

{#if consent && endpoint}
  <AiConsentDialog
    open
    context={consent.built}
    endpointName={endpoint.name}
    endpointUrl={endpoint.baseUrl}
    onconfirm={confirmConsent}
    oncancel={cancelConsent}
  />
{/if}
