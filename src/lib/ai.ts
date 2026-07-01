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

/** How proposed commands reach the terminal. `auto` is honoured on non-prod only. */
export type AiExecMode = "suggest" | "confirm" | "auto";

export interface AiEndpoint {
  id: string;
  name: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  /** Whether an API key is stored for this endpoint in the OS keychain. */
  hasKey: boolean;
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
  /** System prompt for the chat assistant (editable; empty falls back to default). */
  chatSystem: string;
  /** System prompt for the recording → runbook generator (editable). */
  runbookSystem: string;
  /** System prompt for the recording → shell script generator (editable). */
  scriptShSystem: string;
  /** System prompt for the recording → Ansible playbook generator (editable). */
  scriptAnsibleSystem: string;
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
}

const PROVIDERS: AiProvider[] = ["openai", "anthropic"];
const CONTRACTS: AiOutputContract[] = ["markdown", "tools"];
const EXEC_MODES: AiExecMode[] = ["suggest", "confirm", "auto"];

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
  };
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
    chatSystem: DEFAULT_CHAT_SYSTEM,
    runbookSystem: DEFAULT_RUNBOOK_SYSTEM,
    scriptShSystem: DEFAULT_SCRIPT_SH_SYSTEM,
    scriptAnsibleSystem: DEFAULT_SCRIPT_ANSIBLE_SYSTEM,
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
  };
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
    chatSystem: str(r.chatSystem).trim() || d.chatSystem,
    runbookSystem: str(r.runbookSystem).trim() || d.runbookSystem,
    scriptShSystem: str(r.scriptShSystem).trim() || d.scriptShSystem,
    scriptAnsibleSystem: str(r.scriptAnsibleSystem).trim() || d.scriptAnsibleSystem,
  };
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
  return {
    streamId,
    endpointId: ep.id,
    provider: ep.provider,
    baseUrl: ep.baseUrl,
    model: ep.model,
    system,
    messages,
    // Anthropic's /v1/messages requires max_tokens; OpenAI-compatible leaves it open.
    maxTokens: ep.provider === "anthropic" ? 4096 : undefined,
  };
}
