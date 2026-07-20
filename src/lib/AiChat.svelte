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
    trimHistory,
    usageSummary,
    formatElapsed,
    defaultPrompt,
    type AiExecMode,
  } from "./ai";
  import { buildContext, buildRawContext, type RawContext, type BuiltContext } from "./aicontext";
  import { buildSystemPrompt, resolveReplyLanguage, type PromptVars } from "./aicore";
  import { parseChatSegments } from "./aiexec";
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
    isLocal = false,
    promptVars = {},
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
    /** The session is a local shell rather than SSH — shapes the core prompt. */
    isLocal?: boolean;
    /** Values for `{os}`/`{host}`/… placeholders in the user's prompt (Phase 41). */
    promptVars?: PromptVars;
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
    ask: null,
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
  // Which reasoning folds the user opened, by message index. Folded by default:
  // the scratchpad is context for the wait, not the answer.
  let openReasoning = $state<Record<number, boolean>>({});

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

  // How much of the conversation the next request will leave behind (Phase 40).
  // Computed from the live list rather than recorded per-request, so the marker
  // reflects what would be sent *now*, not what was sent last time.
  const droppedFromHistory = $derived(
    trimHistory(
      messages.map((m) => ({ role: m.role, content: m.sent ?? m.content })),
      settings.ai.historyLimit,
      settings.ai.historyCharCap,
    ).dropped,
  );

  /** Endpoints the switcher offers — configured *and* usable (a model chosen). */
  const switchableEndpoints = $derived(settings.ai.endpoints.filter((e) => e.model.trim()));

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

  /**
   * Pick up a question raised elsewhere (terminal "Explain", a container's logs,
   * a metrics snapshot) and route it through the *existing* consent dialog rather
   * than sending it. Callers hand over raw text; redaction and the preview happen
   * here, so no entry point can bypass the consent contract.
   */
  $effect(() => {
    const req = chat.ask;
    if (!req || !ready) return;
    chat.ask = null;
    if (noAi) return; // the server bars the assistant entirely (17.7)
    const built = buildRawContext(req.context, req.label);
    if (built.text) consent = { question: req.question, built };
    else doSend(req.question, "");
  });

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
    void startChat({
      sessionId,
      question,
      context,
      // The non-editable core (output contract, trust boundary, no-TTY rules,
      // production warning) is prepended here rather than living in the editable
      // prompt, so trimming the prompt can no longer switch execution off.
      system: buildSystemPrompt(personaPrompt, sessionFacts(context !== ""), promptVars),
      settings: settings.ai,
      execMode,
      prod,
      noAi,
    });
  }

  const personaPrompt = $derived(
    resolvePromptContent(settings.ai.prompts.chat, chatPromptId, defaultPrompt("chat")),
  );

  /** What the core prompt is built from for this session. */
  function sessionFacts(hasContext: boolean) {
    return {
      kind: isLocal ? ("local" as const) : ("ssh" as const),
      canExecute,
      execMode,
      prod,
      hasContext,
      replyLanguage: resolveReplyLanguage(settings.ai.replyLanguage, settings.language),
    };
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
      {#if switchableEndpoints.length > 1}
        <!-- Endpoint switcher (Phase 40): swapping models mid-question used to
             mean a round trip through settings. -->
        <select
          data-testid="ai-endpoint-switch"
          class="min-w-0 shrink rounded border border-edge bg-panel px-1.5 py-0.5 text-meta text-white outline-none focus:border-accent"
          use:tooltip={t("ai.endpoint")}
          value={endpoint.id}
          onchange={(e) => (settings.ai.activeEndpointId = e.currentTarget.value)}
        >
          {#each switchableEndpoints as ep (ep.id)}
            <option value={ep.id}>{ep.name}</option>
          {/each}
        </select>
      {/if}
      <select
        data-testid="ai-model"
        class="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-0.5 text-meta text-white outline-none focus:border-accent"
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
      class="shrink-0 rounded px-1.5 py-0.5 text-meta text-muted hover:text-white disabled:opacity-50"
      onclick={clearChat}
      disabled={messages.length === 0 || streaming}>{t("ai.clear")}</button
    >
  </div>

  {#if noAi && ready}
    <div
      class="flex items-center gap-1 border-b border-edge bg-panel px-2 py-1 text-meta text-muted"
      data-testid="ai-noai-banner"
    >
      <Icon name="lock" size={12} />
      {t("ai.noAiBanner")}
    </div>
  {/if}

  <div bind:this={scrollEl} class="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 text-xs">
    {#if !ready}
      <p class="py-6 text-center text-meta text-muted">{t("ai.disabledHint")}</p>
    {:else if messages.length === 0}
      <p class="py-6 text-center text-meta text-muted">{t("ai.empty")}</p>
    {/if}
    {#if droppedFromHistory > 0}
      <!-- The conversation outgrew the caps: say so, rather than silently
           dropping turns the user still sees on screen. -->
      <div class="flex items-center gap-2 py-0.5" data-testid="ai-history-trimmed">
        <span class="h-px flex-1 bg-edge"></span>
        <span class="flex items-center gap-1 text-caption text-muted">
          <Icon name="scissors" size={11} />
          {t("ai.historyTrimmed", { count: String(droppedFromHistory) })}
        </span>
        <span class="h-px flex-1 bg-edge"></span>
      </div>
    {/if}
    {#each messages as m, i (i)}
      <div class="rounded border border-edge p-2 {m.role === 'user' ? 'bg-panel' : ''}">
        <div class="mb-1 flex items-center gap-1 text-caption uppercase tracking-wider text-muted">
          <span>{m.role === "user" ? t("ai.you") : t("ai.assistant")}</span>
          {#if m.withContext}
            <span class="flex items-center gap-0.5 text-accent" use:tooltip={t("ai.context.attached")}>
              <Icon name="paperclip" size={10} />
            </span>
          {/if}
        </div>
        {#if m.role === "assistant"}
          {#if m.reasoning}
            <!-- Reasoning fold (Phase 40): a reasoning model can stay silent on
                 the answer channel for a long time, and an empty bubble reads as
                 a hang. Folded by default, and never parsed for command blocks. -->
            <div class="my-1 overflow-hidden rounded border border-edge" data-testid="ai-reasoning">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 bg-panel px-2 py-1 text-left hover:bg-edge"
                aria-expanded={openReasoning[i] === true}
                onclick={() => (openReasoning[i] = !openReasoning[i])}
              >
                <Icon name={openReasoning[i] ? "chevronDown" : "chevronRight"} size={12} class="shrink-0 text-muted" />
                <Icon name="bulb" size={12} class="shrink-0 text-warn" />
                <span class="text-caption text-muted">
                  {streaming && i === messages.length - 1
                    ? t("ai.reasoningLive")
                    : m.elapsedMs
                      ? t("ai.reasoningDone", { time: formatElapsed(m.elapsedMs) })
                      : t("ai.reasoning")}
                </span>
                {#if streaming && i === messages.length - 1}
                  <span class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warn"></span>
                {/if}
              </button>
              {#if openReasoning[i]}
                <div
                  class="whitespace-pre-wrap break-words border-t border-edge p-2 text-meta leading-relaxed text-muted"
                >{m.reasoning}</div>
              {/if}
            </div>
          {/if}
          {#each parseChatSegments(m.content) as seg, si (si)}
            {#if seg.kind === "text"}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <div class="markdown-preview">{@html renderMarkdown(seg.content)}</div>
            {:else}
              <div class="my-1 overflow-hidden rounded border border-edge" data-testid="ai-code">
                <div
                  class="flex items-center justify-between gap-2 border-b border-edge bg-panel px-2 py-0.5"
                >
                  <span class="text-caption uppercase tracking-wider text-muted">
                    {seg.lang || "code"}
                  </span>
                  <div class="flex items-center gap-1">
                    <button
                      class="flex items-center gap-0.5 rounded px-1 py-0.5 text-caption text-muted hover:text-white"
                      aria-label={t("ai.exec.copy")} use:tooltip={t("ai.exec.copy")}
                      onclick={() => copyBlock(seg.content)}
                    >
                      <Icon name="copy" size={11} />
                    </button>
                    {#if seg.runnable && seg.closed && canExecute}
                      <button
                        data-testid="ai-run"
                        class="flex items-center gap-0.5 rounded bg-edge px-1.5 py-0.5 text-caption hover:bg-accent hover:text-panel-alt disabled:opacity-50"
                        disabled={streaming || executed[`${i}:${si}`]}
                        onclick={() => runCommand(sessionId, chat, `${i}:${si}`, seg.content, noAi)}
                      >
                        <Icon name="play" size={11} />
                        {executed[`${i}:${si}`] ? t("ai.exec.ran") : t("ai.exec.run")}
                      </button>
                    {/if}
                  </div>
                </div>
                <pre class="overflow-x-auto p-2 text-meta leading-relaxed text-white"><code
                    >{seg.content}</code
                  ></pre>
              </div>
            {/if}
          {/each}
          {#if !streaming || i !== messages.length - 1}
            {@const u = usageSummary(m.usage, m.elapsedMs)}
            {#if u}
              <!-- Only what the endpoint actually reported: a missing half is
                   omitted, never shown as a zero we didn't measure. -->
              <div
                class="mt-1.5 flex items-center gap-2.5 whitespace-nowrap border-t border-edge pt-1 text-caption text-muted"
                data-testid="ai-usage"
              >
                {#if u.input}
                  <span class="flex items-center gap-0.5" use:tooltip={t("ai.usageIn")}>
                    <Icon name="arrowUp" size={11} />{u.input}
                  </span>
                {/if}
                {#if u.output}
                  <span class="flex items-center gap-0.5" use:tooltip={t("ai.usageOut")}>
                    <Icon name="arrowDown" size={11} />{u.output}
                  </span>
                {/if}
                {#if u.elapsed}
                  <span class="flex items-center gap-0.5" use:tooltip={t("ai.usageTime")}>
                    <Icon name="clock" size={11} />{u.elapsed}
                  </span>
                {/if}
              </div>
            {/if}
          {/if}
        {:else}
          <div class="whitespace-pre-wrap break-words">{m.content}</div>
        {/if}
      </div>
    {/each}
    {#if error}
      <p class="text-meta text-danger" data-testid="ai-error">{error}</p>
    {/if}
  </div>

  {#if pending}
    <!-- Dialog step awaiting the user's go-ahead (dialogConfirm / dangerous cmd). -->
    <div class="border-t border-edge bg-panel px-2 py-2" data-testid="ai-pending">
      <div class="mb-1 text-caption uppercase tracking-wider text-muted">
        {t("ai.dialog.confirmTitle")}
      </div>
      <pre
        class="mb-1.5 overflow-x-auto rounded bg-panel-alt p-2 font-mono text-meta text-white">{pending.command}</pre>
      <div class="flex justify-end gap-2">
        <button
          data-testid="ai-dialog-skip"
          class="rounded px-2 py-1 text-meta text-muted hover:text-white"
          onclick={() => skipDialogStep(sessionId)}>{t("ai.dialog.skip")}</button
        >
        <button
          data-testid="ai-dialog-run"
          class="flex items-center gap-1 rounded bg-accent px-2 py-1 text-meta text-panel-alt hover:bg-accent-hover"
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
          class="flex items-center gap-1 rounded-l px-1.5 py-1 text-meta disabled:opacity-40 {attach
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
          class="rounded-r px-1 py-1 text-meta text-muted hover:text-white disabled:opacity-40"
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
            class="absolute bottom-full left-0 z-50 mb-1 w-60 rounded border border-edge bg-panel-alt p-2 text-meta shadow-lg"
            data-testid="ai-tiers-menu"
          >
            <p class="mb-1.5 text-caption text-muted">{t("ai.context.base")}</p>
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
