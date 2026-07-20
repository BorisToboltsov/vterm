// Endpoint presets for the AI assistant (Phase 40).
//
// A preset is *only* a set of pre-filled form values — it is NOT a third
// transport. `AiProvider` stays the two real wire protocols (`openai` =
// OpenAI-compatible `/chat/completions`, `anthropic` = native `/v1/messages`);
// every vendor below speaks one of them, so adding DeepSeek/LM Studio/vLLM costs
// zero backend code. Per the architecture invariant the Rust broker stays a dumb
// executor and the variety lives here, in pure `.ts`.
//
// Vendor/product names are domain terms and stay untranslated (i18n rule); only
// the group headings in the menu go through `t()`.
import type { AiEndpoint, AiProvider } from "./ai";

/** Where a preset runs — drives the menu grouping and the key hint. */
export type AiPresetKind = "local" | "cloud";

export interface AiPreset {
  id: string;
  /** Vendor/product name shown in the menu (not translated). */
  label: string;
  kind: AiPresetKind;
  provider: AiProvider;
  baseUrl: string;
  /**
   * Starting model id. Model names churn fast, so this is a hint the user can
   * replace — "Check connection" fetches the endpoint's real list into the
   * picker. Empty is allowed for servers that serve whatever was loaded (vLLM),
   * where any guess would be wrong; the form then asks for it.
   */
  model: string;
  /** Whether this endpoint normally needs an API key (hint only, not a gate). */
  needsKey: boolean;
}

/**
 * The presets offered by "Add endpoint". Local first — the offline-friendly
 * default this app is built around; cloud below it.
 *
 * Model ids checked against vendor docs on 2026-07-19. `deepseek-chat` /
 * `deepseek-reasoner` are deprecated as of 2026-07-24 and deliberately not used.
 */
export const AI_PRESETS: AiPreset[] = [
  {
    id: "ollama",
    label: "Ollama",
    kind: "local",
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3",
    needsKey: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    kind: "local",
    provider: "openai",
    baseUrl: "http://localhost:1234/v1",
    // LM Studio's own docs use this placeholder id for "whatever is loaded".
    model: "local-model",
    needsKey: false,
  },
  {
    id: "vllm",
    label: "vLLM",
    kind: "local",
    provider: "openai",
    baseUrl: "http://localhost:8000/v1",
    // vLLM serves exactly the model it was launched with (an arbitrary HF path),
    // so any default here would be wrong — the picker fills it after a check.
    model: "",
    needsKey: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "cloud",
    provider: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
    needsKey: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "cloud",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-terra",
    needsKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "cloud",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-opus-4-8",
    needsKey: true,
  },
];

/** Presets of one kind, in registry order (menu grouping). */
export function presetsOfKind(kind: AiPresetKind): AiPreset[] {
  return AI_PRESETS.filter((p) => p.kind === kind);
}

/** Look a preset up by id; null when unknown (e.g. a stale menu id). */
export function presetById(id: string): AiPreset | null {
  return AI_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * A fresh endpoint pre-filled from a preset. Mirrors `newAiEndpoint` but takes
 * the name/url/model from the registry; the id is fresh so two endpoints from
 * the same preset don't share a keychain entry.
 */
export function endpointFromPreset(p: AiPreset): AiEndpoint {
  return {
    id: crypto.randomUUID(),
    name: p.label,
    provider: p.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    hasKey: false,
    basePrompt: "",
    params: "",
    maxTokens: null,
    timeoutSec: null,
  };
}
