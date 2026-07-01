// Pure AI-assistant configuration model (Phase 17, opt-in).
// DOM/network-free so it is unit-tested directly. All actual LLM traffic lives in
// the Rust backend (reqwest) — the frontend never calls an LLM endpoint, so the
// offline autonomy guard and strict CSP stay intact. API keys live in the OS
// keychain (service `vterm:ai-key`), never here.

/** `openai` = any OpenAI-compatible `/v1/chat/completions` endpoint (Ollama, vLLM,
 *  LM Studio, llama.cpp, local Qwen, OpenAI). `anthropic` = native Claude API. */
export type AiProvider = "openai" | "anthropic";

/** How the model returns runnable commands (switchable in settings, Phase 17). */
export type AiOutputContract = "markdown" | "tools";

/** How proposed commands reach the terminal. `auto`/`dialog`/`dialogConfirm` are
 *  honoured on non-prod only. `dialog*` run an execute→read-output→next-step loop. */
export type AiExecMode = "suggest" | "confirm" | "auto" | "dialog" | "dialogConfirm";

export interface AiEndpoint {
  id: string;
  name: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  /** Whether an API key is stored for this endpoint in the OS keychain. */
  hasKey: boolean;
  /** Model-wide base system prompt; kind-specific prompts append to it. */
  basePrompt?: string;
  /** Extra generation params as raw JSON (temperature, top_p…), merged into the
   *  request body. Invalid/empty → ignored. */
  params?: string;
}

/** The four kinds of system prompt the assistant uses. */
export type AiPromptKind = "chat" | "runbook" | "sh" | "ansible";
export const AI_PROMPT_KINDS: AiPromptKind[] = ["chat", "runbook", "sh", "ansible"];

/** One named, editable system prompt. Per-server selection lives on the server
 *  profile (`chatPromptId`), so a prompt itself carries no server link. */
export interface AiPrompt {
  id: string;
  name: string;
  content: string;
}

/** The list of prompts for one kind plus the chosen default (`activeId`). */
export interface AiPromptSet {
  prompts: AiPrompt[];
  activeId: string | null;
}

export interface AiSettings {
  /** Master switch — OFF by default (opt-in). */
  enabled: boolean;
  endpoints: AiEndpoint[];
  activeEndpointId: string | null;
  contract: AiOutputContract;
  execMode: AiExecMode;
  /** Context tiers — selection/last-N is always allowed; these widen it (opt-in),
   *  still gated by redaction + consent before anything is sent. */
  includeBuffer: boolean;
  includeRecording: boolean;
  includeMetadata: boolean;
  /** Editable system prompts per kind — each a list with an active default and
   *  optional per-server scoping (see {@link resolvePromptContent}). */
  prompts: Record<AiPromptKind, AiPromptSet>;
}

/** One chat turn sent to the backend broker. */
export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Request the Rust broker streams to the model (mirror of ai.rs AiChatRequest). */
export interface AiChatRequest {
  /** Correlates the `ai://…/{streamId}` event channel with this request. */
  streamId: string;
  endpointId: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  system?: string;
  messages: AiChatMessage[];
  maxTokens?: number;
  /** Extra generation params merged into the request body (temperature, top_p…). */
  params?: Record<string, unknown>;
}

const PROVIDERS: AiProvider[] = ["openai", "anthropic"];
const CONTRACTS: AiOutputContract[] = ["markdown", "tools"];
const EXEC_MODES: AiExecMode[] = ["suggest", "confirm", "auto", "dialog", "dialogConfirm"];

/** Default system prompt for the chat assistant (user-editable in settings). */
export const DEFAULT_CHAT_SYSTEM =
  "You are a concise assistant for a sysadmin/DevOps engineer working in an SSH terminal. " +
  "Be brief and practical. When you suggest shell commands, put each runnable command in its " +
  "own fenced ```bash code block.";

/** Default system prompt for the recording → runbook generator (user-editable). */
export const DEFAULT_RUNBOOK_SYSTEM =
  "You are a senior DevOps engineer. Given a raw terminal session transcript, write a clear, " +
  "ordered runbook that reproduces what was done: a one-line summary, prerequisites, numbered " +
  "steps with the exact shell commands, and verification checks at the end. Use Markdown and put " +
  "each runnable command in its own fenced ```bash block. Ignore shell prompts, redraw noise and " +
  "typos; keep it concise.";

/** Default system prompt for the recording → shell script generator (user-editable). */
export const DEFAULT_SCRIPT_SH_SYSTEM =
  "You are a senior DevOps engineer. Given a raw terminal session transcript, produce a single " +
  "POSIX/bash script that reproduces what was done. Begin with `#!/usr/bin/env bash` and " +
  "`set -euo pipefail`, add brief comments, use variables for repeated values, and drop interactive " +
  "prompts and redraw noise. Output ONLY the script inside one fenced ```bash block — no prose.";

/** Default system prompt for the recording → Ansible playbook generator (user-editable). */
export const DEFAULT_SCRIPT_ANSIBLE_SYSTEM =
  "You are a senior DevOps engineer. Given a raw terminal session transcript, produce a single " +
  "idempotent Ansible playbook that reproduces what was done, preferring standard modules " +
  "(apt/yum, copy, template, service, user, …) over raw shell where possible. Output ONLY valid " +
  "YAML inside one fenced ```yaml block — no prose.";

/** Built-in default content per prompt kind. */
export const DEFAULT_PROMPT: Record<AiPromptKind, string> = {
  chat: DEFAULT_CHAT_SYSTEM,
  runbook: DEFAULT_RUNBOOK_SYSTEM,
  sh: DEFAULT_SCRIPT_SH_SYSTEM,
  ansible: DEFAULT_SCRIPT_ANSIBLE_SYSTEM,
};

/** A fresh prompt for a kind (used by "add prompt" and by defaults/migration). */
export function newAiPrompt(kind: AiPromptKind, name = "Default"): AiPrompt {
  return { id: crypto.randomUUID(), name, content: DEFAULT_PROMPT[kind] };
}

/** A prompt set with a single default prompt, active. */
export function defaultPromptSet(kind: AiPromptKind): AiPromptSet {
  const p = newAiPrompt(kind);
  return { prompts: [p], activeId: p.id };
}

/**
 * The prompt content to use for a kind: a preferred prompt (by id — e.g. a
 * server's chosen chat prompt) wins when present, otherwise the active prompt,
 * otherwise the first, otherwise the built-in default. Never returns empty.
 */
export function resolvePromptContent(
  set: AiPromptSet | undefined,
  preferredId: string | null,
  fallback: string,
): string {
  if (!set || set.prompts.length === 0) return fallback;
  if (preferredId) {
    const p = set.prompts.find((x) => x.id === preferredId);
    if (p && p.content.trim()) return p.content;
  }
  const active = set.prompts.find((p) => p.id === set.activeId) ?? set.prompts[0];
  return active.content.trim() ? active.content : fallback;
}

/** Default endpoint that a user typically overrides (local Qwen via Ollama, or Claude). */
export function defaultBaseUrl(provider: AiProvider): string {
  return provider === "anthropic" ? "https://api.anthropic.com" : "http://localhost:11434/v1";
}

/** Default model hint per provider (user-editable). */
export function defaultModel(provider: AiProvider): string {
  return provider === "anthropic" ? "claude-opus-4-8" : "qwen2.5";
}

export function newAiEndpoint(provider: AiProvider = "openai"): AiEndpoint {
  return {
    id: crypto.randomUUID(),
    name: provider === "anthropic" ? "Claude" : "Local",
    provider,
    baseUrl: defaultBaseUrl(provider),
    model: defaultModel(provider),
    hasKey: false,
    basePrompt: "",
    params: "",
  };
}

/** Parse an endpoint's extra-params JSON; null for empty / invalid / non-object. */
export function parseParams(text: string | undefined): Record<string, unknown> | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function defaultAiSettings(): AiSettings {
  return {
    enabled: false,
    endpoints: [],
    activeEndpointId: null,
    contract: "markdown",
    execMode: "confirm",
    includeBuffer: false,
    includeRecording: false,
    includeMetadata: false,
    prompts: {
      chat: defaultPromptSet("chat"),
      runbook: defaultPromptSet("runbook"),
      sh: defaultPromptSet("sh"),
      ansible: defaultPromptSet("ansible"),
    },
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Validate a stored endpoint; null for junk or missing baseUrl/model. */
export function sanitizeEndpoint(raw: unknown): AiEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = str(r.baseUrl).trim();
  const model = str(r.model).trim();
  if (!baseUrl || !model) return null;
  const provider = PROVIDERS.includes(r.provider as AiProvider)
    ? (r.provider as AiProvider)
    : "openai";
  return {
    id: str(r.id) || crypto.randomUUID(),
    name: str(r.name).trim() || "Endpoint",
    provider,
    baseUrl,
    model,
    hasKey: r.hasKey === true,
    basePrompt: str(r.basePrompt),
    params: str(r.params),
  };
}

/** Validate one stored prompt; null when it has no content. */
function sanitizePrompt(raw: unknown): AiPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const content = str(r.content);
  if (!content.trim()) return null;
  return {
    id: str(r.id) || crypto.randomUUID(),
    name: str(r.name).trim() || "Prompt",
    content,
  };
}

/** Validate a stored prompt set; migrate a legacy single-string prompt / default. */
function sanitizePromptSet(raw: unknown, kind: AiPromptKind, legacy: string): AiPromptSet {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let prompts = Array.isArray(r.prompts)
    ? r.prompts.map(sanitizePrompt).filter((p): p is AiPrompt => p !== null)
    : [];
  if (prompts.length === 0) {
    const p = newAiPrompt(kind);
    if (legacy.trim()) p.content = legacy.trim();
    prompts = [p];
  }
  const ids = new Set(prompts.map((p) => p.id));
  const activeId =
    typeof r.activeId === "string" && ids.has(r.activeId) ? r.activeId : prompts[0].id;
  return { prompts, activeId };
}

/** Validate stored AI settings, falling back to defaults for junk. */
export function sanitizeAiSettings(raw: unknown): AiSettings {
  const d = defaultAiSettings();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const endpoints = Array.isArray(r.endpoints)
    ? r.endpoints.map(sanitizeEndpoint).filter((e): e is AiEndpoint => e !== null)
    : [];
  const ids = new Set(endpoints.map((e) => e.id));
  const activeEndpointId =
    typeof r.activeEndpointId === "string" && ids.has(r.activeEndpointId)
      ? r.activeEndpointId
      : (endpoints[0]?.id ?? null);
  return {
    enabled: r.enabled === true,
    endpoints,
    activeEndpointId,
    contract: CONTRACTS.includes(r.contract as AiOutputContract)
      ? (r.contract as AiOutputContract)
      : d.contract,
    execMode: EXEC_MODES.includes(r.execMode as AiExecMode)
      ? (r.execMode as AiExecMode)
      : d.execMode,
    includeBuffer: r.includeBuffer === true,
    includeRecording: r.includeRecording === true,
    includeMetadata: r.includeMetadata === true,
    prompts: (() => {
      const rp = (r.prompts && typeof r.prompts === "object" ? r.prompts : {}) as Record<
        string,
        unknown
      >;
      return {
        chat: sanitizePromptSet(rp.chat, "chat", str(r.chatSystem)),
        runbook: sanitizePromptSet(rp.runbook, "runbook", str(r.runbookSystem)),
        sh: sanitizePromptSet(rp.sh, "sh", str(r.scriptShSystem)),
        ansible: sanitizePromptSet(rp.ansible, "ansible", str(r.scriptAnsibleSystem)),
      };
    })(),
  };
}

/** Coarse category of an AI request failure (for a friendly, localized message). */
export type AiErrorKind = "auth" | "unreachable" | "billing" | "rate" | "other";

/**
 * Classify an error thrown by an AI command (chat/models). The backend marks
 * auth failures (`auth-rejected`, 401/403) and connection failures
 * (`ai-unreachable`), and unwraps the provider's message (e.g. "Your credit
 * balance is too low…"); we sniff those for billing/rate-limit too. `other`
 * keeps the (now clean) provider detail.
 */
export function aiErrorKind(err: unknown): AiErrorKind {
  const s = String(err instanceof Error ? err.message : err).toLowerCase();
  if (
    s.includes("auth-rejected") ||
    /\b401\b|\b403\b|unauthorized|forbidden|permission denied|invalid[\s_-]*api|x-api-key/.test(s)
  ) {
    return "auth";
  }
  if (
    s.includes("ai-unreachable") ||
    /connection refused|error sending request|error trying to connect|failed to connect|dns error|timed out|timeout|no route to host|network is unreachable|tcp connect/.test(s)
  ) {
    return "unreachable";
  }
  if (
    /credit balance|insufficient|quota|billing|payment required|out of credits|\b402\b|top up/.test(s)
  ) {
    return "billing";
  }
  if (/rate.?limit|too many requests|\b429\b/.test(s)) {
    return "rate";
  }
  return "other";
}

/** Effective execution mode: a valid per-server override wins, else the global. */
export function effectiveExecMode(override: string | null | undefined, global: AiExecMode): AiExecMode {
  return EXEC_MODES.includes(override as AiExecMode) ? (override as AiExecMode) : global;
}

/** Options for the chat model picker: fetched models ∪ the current one, sorted. */
export function mergeModelOptions(fetched: string[], current: string): string[] {
  const set = new Set(fetched.filter(Boolean));
  if (current) set.add(current);
  return [...set].sort();
}

/** The active endpoint, or null when AI is off / none configured. */
export function activeEndpoint(s: AiSettings): AiEndpoint | null {
  if (!s.enabled || !s.activeEndpointId) return null;
  return s.endpoints.find((e) => e.id === s.activeEndpointId) ?? null;
}

/** Whether the assistant can run at all (enabled + a usable active endpoint). */
export function aiReady(s: AiSettings): boolean {
  return s.enabled && activeEndpoint(s) !== null;
}

/** Build the backend chat request from settings + conversation, or null when not ready. */
export function buildChatRequest(
  s: AiSettings,
  streamId: string,
  messages: AiChatMessage[],
  system?: string,
): AiChatRequest | null {
  const ep = activeEndpoint(s);
  if (!ep) return null;
  // The endpoint's base prompt is a model-wide preamble; the kind-specific prompt
  // (chat/runbook/…) appends to it.
  const base = (ep.basePrompt ?? "").trim();
  const fullSystem = [base, system].filter((x) => x && x.trim()).join("\n\n") || undefined;
  return {
    streamId,
    endpointId: ep.id,
    provider: ep.provider,
    baseUrl: ep.baseUrl,
    model: ep.model,
    system: fullSystem,
    messages,
    // Anthropic's /v1/messages requires max_tokens; OpenAI-compatible leaves it open.
    maxTokens: ep.provider === "anthropic" ? 4096 : undefined,
    params: parseParams(ep.params) ?? undefined,
  };
}
