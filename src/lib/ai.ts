import { defaultPromptFor, isShippedDefault } from "./aiprompts";
import { DEFAULT_LOCALE } from "./i18n/locales";
import { AI_REPLY_LANGUAGES, type AiReplyLanguage } from "./aicore";

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

/** How proposed commands reach the terminal. `dialog`/`dialogConfirm` are honoured
 *  on non-prod only and run an execute→read-output→next-step loop. */
export type AiExecMode = "suggest" | "confirm" | "dialog" | "dialogConfirm";

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
  /** Cap on the reply length, in tokens. `null` = let the endpoint decide
   *  (Anthropic has no default, so {@link ANTHROPIC_FALLBACK_MAX_TOKENS} is
   *  used there). An explicit value is still overridable via `params`. */
  maxTokens?: number | null;
  /** Per-request timeout in seconds. `null` = {@link DEFAULT_AI_TIMEOUT_SEC}. */
  timeoutSec?: number | null;
}

/** Anthropic's `/v1/messages` requires `max_tokens`, so one is sent regardless. */
export const ANTHROPIC_FALLBACK_MAX_TOKENS = 4096;

/** Request timeout used when an endpoint doesn't set its own. */
export const DEFAULT_AI_TIMEOUT_SEC = 120;

/** Bounds for the per-endpoint numeric fields (guard against junk/0/negatives). */
export const MAX_TOKENS_RANGE = { min: 1, max: 200_000 };
export const TIMEOUT_RANGE = { min: 5, max: 900 };

/**
 * Normalise an optional bounded integer setting: a finite number inside
 * `[min, max]` survives (clamped), anything else — junk, 0, a blank field —
 * becomes `null`, i.e. "use the default". Blank must stay `null` rather than
 * collapsing to the min, so an empty box keeps meaning "endpoint decides".
 */
export function sanitizeOptionalInt(
  raw: unknown,
  { min, max }: { min: number; max: number },
): number | null {
  const n = typeof raw === "number" ? raw : Number.parseInt(str(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** The kinds of system prompt the assistant uses. `postmortem` and `commit` are
 *  Phase 41; the first four predate it. */
export type AiPromptKind = "chat" | "runbook" | "sh" | "ansible" | "postmortem" | "commit";
export const AI_PROMPT_KINDS: AiPromptKind[] = [
  "chat",
  "runbook",
  "sh",
  "ansible",
  "postmortem",
  "commit",
];

/** One named, editable system prompt. Per-server selection lives on the server
 *  profile (`chatPromptId`), so a prompt itself carries no server link. */
export interface AiPrompt {
  id: string;
  name: string;
  content: string;
  /**
   * `builtin` = still exactly as shipped, so a language change may re-seed it;
   * `custom` = the user has edited it and it is never touched again.
   *
   * Without this there is no way to tell "the default nobody read" from "text the
   * user happens to have written identically", and localisation would have to
   * choose between clobbering edits and never updating anything.
   */
  origin?: "builtin" | "custom";
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
  /** User-added substrings that additionally force a confirmation before the
   *  assistant runs a command (case-insensitive `includes`). Additive only — they
   *  extend the built-in destructive-command list in `aidialog.ts`, never weaken
   *  it. See {@link sanitizeDangerousPatterns} for the stored shape/limits. */
  dangerousPatterns: string[];
  /** How many trailing conversation messages are replayed to the model each
   *  turn (see {@link trimHistory}). `null` = no message cap. */
  historyLimit: number | null;
  /** Hard ceiling on the characters of history sent per request. `null` = none. */
  historyCharCap: number | null;
  /** Language the model answers in. Deliberately independent of the interface
   *  language: a Russian UI with English answers is a real preference (replies get
   *  pasted into tickets and greped next to logs). */
  replyLanguage: AiReplyLanguage;
}

/** Caps on the user's custom confirm-patterns list (guards against junk/DoS). */
export const MAX_DANGEROUS_PATTERNS = 100;
export const MAX_DANGEROUS_PATTERN_LEN = 200;

/** Normalise the custom confirm-patterns list: trim, drop empties, de-dupe
 *  case-insensitively, clip each to {@link MAX_DANGEROUS_PATTERN_LEN} and the whole
 *  list to {@link MAX_DANGEROUS_PATTERNS}. Non-array / junk → []. */
export function sanitizeDangerousPatterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const p = str(v).trim().slice(0, MAX_DANGEROUS_PATTERN_LEN);
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_DANGEROUS_PATTERNS) break;
  }
  return out;
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
  /** Per-request timeout in seconds (the broker's reqwest client timeout). */
  timeoutSec?: number;
}

const PROVIDERS: AiProvider[] = ["openai", "anthropic"];
const CONTRACTS: AiOutputContract[] = ["markdown", "tools"];
const EXEC_MODES: AiExecMode[] = ["suggest", "confirm", "dialog", "dialogConfirm"];

/**
 * The shipped prompt for a kind, in the given locale (Phase 41). Prompts moved to
 * {@link aiprompts} so they can be localised; this stays the single entry point
 * the rest of the app uses.
 *
 * The locale defaults to the stored UI language rather than taking it as a
 * required argument, because `defaultAiSettings()` runs at module init — before
 * anything has had a chance to pass one in.
 */
export function defaultPrompt(kind: AiPromptKind, locale: string = storedLocale()): string {
  return defaultPromptFor(kind, locale);
}

/**
 * The UI language as persisted, read directly rather than through the settings
 * store: this module is imported *by* that store, so reaching back into it would
 * be a cycle. Falls back to English when storage is unavailable (tests, SSR).
 */
function storedLocale(): string {
  try {
    const raw = globalThis.localStorage?.getItem("vterm.settings");
    const lang = raw ? (JSON.parse(raw) as { language?: unknown }).language : null;
    return typeof lang === "string" ? lang : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** A fresh prompt for a kind (used by "add prompt" and by defaults/migration). */
export function newAiPrompt(kind: AiPromptKind, name = "Default"): AiPrompt {
  return { id: crypto.randomUUID(), name, content: defaultPrompt(kind), origin: "builtin" };
}

/** Build a `Record<AiPromptKind, T>` from a per-kind factory — keeps every place
 *  that maps over the kinds from having to list them (and drift when one is added). */
function promptSets(make: (k: AiPromptKind) => AiPromptSet): Record<AiPromptKind, AiPromptSet> {
  return Object.fromEntries(AI_PROMPT_KINDS.map((k) => [k, make(k)])) as Record<
    AiPromptKind,
    AiPromptSet
  >;
}

/** Pre-Phase-18 flat prompt fields, by the kind they migrate into. */
const LEGACY_PROMPT_KEY: Partial<Record<AiPromptKind, string>> = {
  chat: "chatSystem",
  runbook: "runbookSystem",
  sh: "scriptShSystem",
  ansible: "scriptAnsibleSystem",
};

/** A prompt set with a single default prompt, active. */
export function defaultPromptSet(kind: AiPromptKind): AiPromptSet {
  const p = newAiPrompt(kind);
  return { prompts: [p], activeId: p.id };
}

/**
 * Re-seed every untouched (`origin: "builtin"`) prompt with the shipped text for
 * `locale`, leaving anything the user edited alone. Returns a new prompts record;
 * the caller decides whether anything changed.
 *
 * This is why {@link AiPrompt.origin} exists: without it, switching the interface
 * language could only ever pick between clobbering the user's edits and never
 * localising anything.
 */
export function reseedBuiltinPrompts(
  prompts: Record<AiPromptKind, AiPromptSet>,
  locale: string,
): Record<AiPromptKind, AiPromptSet> {
  return promptSets((kind) => {
    const set = prompts[kind];
    if (!set) return defaultPromptSet(kind);
    return {
      ...set,
      prompts: set.prompts.map((p) =>
        p.origin === "builtin" ? { ...p, content: defaultPromptFor(kind, locale) } : p,
      ),
    };
  });
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
    maxTokens: null,
    timeoutSec: null,
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
      ...promptSets((k) => defaultPromptSet(k)),
    },
    dangerousPatterns: [],
    historyLimit: DEFAULT_HISTORY_LIMIT,
    historyCharCap: DEFAULT_HISTORY_CHAR_CAP,
    replyLanguage: "auto",
  };
}

/** Default history caps. Before Phase 40 the whole conversation was replayed on
 *  every turn, so a long dialog (or a dialog loop with terminal context attached
 *  to each step) grew the request without bound — cost and context-limit errors. */
export const DEFAULT_HISTORY_LIMIT = 12;
export const DEFAULT_HISTORY_CHAR_CAP = 32_000;

export const HISTORY_LIMIT_RANGE = { min: 2, max: 200 };
export const HISTORY_CHAR_CAP_RANGE = { min: 1_000, max: 2_000_000 };

/** History actually sent to the model, plus what it cost, for the chat's marker. */
export interface TrimmedHistory {
  messages: AiChatMessage[];
  /** Leading messages left out of this request (0 = the full conversation). */
  dropped: number;
  /** Characters of history in the request (excludes the system prompt). */
  chars: number;
}

/**
 * Keep the newest part of a conversation within both caps, oldest dropped first.
 *
 * The message cap applies before the character cap. The last message always
 * survives — it is the question being asked, and sending an empty conversation
 * would be worse than sending an oversized one. A leading `assistant` message is
 * then dropped as well: Anthropic's `/v1/messages` rejects a conversation that
 * doesn't start with a user turn, so a trim that lands mid-exchange would turn a
 * long chat into a hard 400.
 *
 * `null` for either cap disables it.
 */
export function trimHistory(
  messages: AiChatMessage[],
  limit: number | null,
  charCap: number | null,
): TrimmedHistory {
  const total = messages.length;
  let kept = limit && limit > 0 ? messages.slice(-limit) : messages.slice();

  if (charCap && charCap > 0) {
    let chars = kept.reduce((n, m) => n + m.content.length, 0);
    while (kept.length > 1 && chars > charCap) {
      chars -= kept[0].content.length;
      kept = kept.slice(1);
    }
  }
  // Never open on an assistant turn (Anthropic rejects it); the sole remaining
  // message is left alone, since dropping it would send nothing at all.
  while (kept.length > 1 && kept[0].role === "assistant") {
    kept = kept.slice(1);
  }

  return {
    messages: kept,
    dropped: total - kept.length,
    chars: kept.reduce((n, m) => n + m.content.length, 0),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Validate a stored endpoint; null for junk or a missing baseUrl.
 *
 * The model may be empty: an endpoint whose model is still to be chosen is a
 * real state (the vLLM preset ships without one, and clearing the field in the
 * form produces it too), and dropping the whole endpoint over it would delete
 * the user's URL and keychain link behind their back. Usability is decided by
 * {@link activeEndpoint} instead, which refuses a model-less endpoint.
 */
export function sanitizeEndpoint(raw: unknown): AiEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = str(r.baseUrl).trim();
  const model = str(r.model).trim();
  if (!baseUrl) return null;
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
    maxTokens: sanitizeOptionalInt(r.maxTokens, MAX_TOKENS_RANGE),
    timeoutSec: sanitizeOptionalInt(r.timeoutSec, TIMEOUT_RANGE),
  };
}

/**
 * Validate one stored prompt; null when it has no content.
 *
 * `origin` is absent in settings written before Phase 41. Rather than assume, the
 * content is compared against the shipped defaults **in every locale**: a match
 * means nobody edited it (so a language change may re-seed it), anything else is
 * treated as the user's own text and left alone forever. Guessing the other way
 * would eventually overwrite something somebody wrote.
 */
function sanitizePrompt(raw: unknown, kind: AiPromptKind): AiPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const content = str(r.content);
  if (!content.trim()) return null;
  const stored = r.origin;
  const origin: "builtin" | "custom" =
    stored === "builtin" || stored === "custom"
      ? stored
      : isShippedDefault(kind, content)
        ? "builtin"
        : "custom";
  return {
    id: str(r.id) || crypto.randomUUID(),
    name: str(r.name).trim() || "Prompt",
    content,
    origin,
  };
}

/** Validate a stored prompt set; migrate a legacy single-string prompt / default. */
function sanitizePromptSet(raw: unknown, kind: AiPromptKind, legacy: string): AiPromptSet {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let prompts = Array.isArray(r.prompts)
    ? r.prompts.map((x) => sanitizePrompt(x, kind)).filter((p): p is AiPrompt => p !== null)
    : [];
  if (prompts.length === 0) {
    const p = newAiPrompt(kind);
    if (legacy.trim()) {
      p.content = legacy.trim();
      // Text migrated out of the old flat field is the user's, unless it happens
      // to be a shipped default verbatim.
      p.origin = isShippedDefault(kind, p.content) ? "builtin" : "custom";
    }
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
        // Legacy single-string prompts only ever existed for the original four
        // kinds; the Phase 41 kinds simply seed their default.
        ...promptSets((k) => sanitizePromptSet(rp[k], k, str(r[LEGACY_PROMPT_KEY[k] ?? ""]))),
      };
    })(),
    dangerousPatterns: sanitizeDangerousPatterns(r.dangerousPatterns),
    // Absent (settings written before Phase 40) → the defaults, not "no cap":
    // unbounded history is the defect this phase fixes, so an upgrade opts in.
    historyLimit:
      r.historyLimit === null
        ? null
        : (sanitizeOptionalInt(r.historyLimit, HISTORY_LIMIT_RANGE) ?? d.historyLimit),
    historyCharCap:
      r.historyCharCap === null
        ? null
        : (sanitizeOptionalInt(r.historyCharCap, HISTORY_CHAR_CAP_RANGE) ?? d.historyCharCap),
    replyLanguage: AI_REPLY_LANGUAGES.includes(r.replyLanguage as AiReplyLanguage)
      ? (r.replyLanguage as AiReplyLanguage)
      : d.replyLanguage,
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

/** Token counts for one reply (mirror of ai.rs `AiUsage`). */
export interface AiUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** The per-reply footer: prompt tokens, reply tokens, wall-clock time. */
export interface UsageSummary {
  input: string | null;
  output: string | null;
  elapsed: string | null;
}

/**
 * Group a token count (`1 240`). Deterministic rather than locale-dependent, so
 * the string asserted in tests is the string every user sees.
 *
 * A plain ASCII space on purpose: a no-break space keeps the number together but
 * is invisible in source, and one mismatched against a test turns a failing
 * assertion into a riddle. The markup carries `whitespace-nowrap` instead.
 */
export function formatTokens(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Wall-clock duration for the reply footer: `0.8 s`, `6.1 s`, `1:04`. */
export function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The reply footer, or `null` when there is nothing measured to show.
 *
 * Each field is independently optional: an endpoint that reports only output
 * tokens gets one number, not a zero-filled row. A tally the endpoint never sent
 * must not be invented — same rule as the host-capability gate, where "no data"
 * and "not available here" are never papered over with a plausible placeholder.
 */
export function usageSummary(
  usage: AiUsage | undefined,
  elapsedMs: number | undefined,
): UsageSummary | null {
  const num = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? formatTokens(v) : null;
  const row: UsageSummary = {
    input: num(usage?.inputTokens),
    output: num(usage?.outputTokens),
    elapsed:
      typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > 0
        ? formatElapsed(elapsedMs)
        : null,
  };
  return row.input || row.output || row.elapsed ? row : null;
}

/** Options for the chat model picker: fetched models ∪ the current one, sorted. */
export function mergeModelOptions(fetched: string[], current: string): string[] {
  const set = new Set(fetched.filter(Boolean));
  if (current) set.add(current);
  return [...set].sort();
}

/**
 * The active, *usable* endpoint — null when AI is off, none is selected, or the
 * selected one has no model yet (see {@link sanitizeEndpoint}: such an endpoint
 * is kept in settings, but nothing can be sent to it).
 */
export function activeEndpoint(s: AiSettings): AiEndpoint | null {
  if (!s.enabled || !s.activeEndpointId) return null;
  const ep = s.endpoints.find((e) => e.id === s.activeEndpointId) ?? null;
  return ep && ep.model.trim() ? ep : null;
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
  // Anthropic's /v1/messages requires max_tokens, so it falls back to a value;
  // OpenAI-compatible endpoints are left open unless the user set one.
  const maxTokens =
    ep.maxTokens ??
    (ep.provider === "anthropic" ? ANTHROPIC_FALLBACK_MAX_TOKENS : undefined) ??
    undefined;
  return {
    streamId,
    endpointId: ep.id,
    provider: ep.provider,
    baseUrl: ep.baseUrl,
    model: ep.model,
    system: fullSystem,
    messages: trimHistory(messages, s.historyLimit, s.historyCharCap).messages,
    maxTokens,
    params: parseParams(ep.params) ?? undefined,
    timeoutSec: ep.timeoutSec ?? DEFAULT_AI_TIMEOUT_SEC,
  };
}
