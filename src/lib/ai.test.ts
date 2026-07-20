import { describe, it, expect } from "vitest";
import {
  defaultAiSettings,
  defaultBaseUrl,
  defaultModel,
  newAiEndpoint,
  sanitizeEndpoint,
  sanitizeAiSettings,
  activeEndpoint,
  aiReady,
  buildChatRequest,
  mergeModelOptions,
  resolvePromptContent,
  effectiveExecMode,
  parseParams,
  aiErrorKind,
  sanitizeDangerousPatterns,
  MAX_DANGEROUS_PATTERNS,
  MAX_DANGEROUS_PATTERN_LEN,
  trimHistory,
  usageSummary,
  formatTokens,
  formatElapsed,
  sanitizeOptionalInt,
  ANTHROPIC_FALLBACK_MAX_TOKENS,
  DEFAULT_AI_TIMEOUT_SEC,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HISTORY_CHAR_CAP,
  MAX_TOKENS_RANGE,
  TIMEOUT_RANGE,
  type AiChatMessage,
} from "./ai";

describe("ai defaults", () => {
  it("is opt-in (disabled) with no endpoints by default", () => {
    const d = defaultAiSettings();
    expect(d.enabled).toBe(false);
    expect(d.endpoints).toEqual([]);
    expect(d.activeEndpointId).toBeNull();
    expect(d.execMode).toBe("confirm");
    expect(d.contract).toBe("markdown");
    // Editable prompts default to one built-in prompt per kind, active.
    expect(d.prompts.chat.prompts).toHaveLength(1);
    // The ```bash contract moved to the non-editable core in Phase 41 — the
    // editable prompt is persona only, so trimming it can't disable execution.
    expect(d.prompts.chat.prompts[0].content.trim()).not.toBe("");
    expect(d.prompts.chat.activeId).toBe(d.prompts.chat.prompts[0].id);
    expect(d.prompts.runbook.prompts[0].content.toLowerCase()).toContain("runbook");
    // No custom confirm-patterns until the user adds them.
    expect(d.dangerousPatterns).toEqual([]);
  });

  it("provides sensible per-provider defaults", () => {
    expect(defaultBaseUrl("anthropic")).toMatch(/anthropic/);
    expect(defaultBaseUrl("openai")).toMatch(/11434|localhost/);
    expect(defaultModel("anthropic")).toBe("claude-opus-4-8");
    const ep = newAiEndpoint("anthropic");
    expect(ep.provider).toBe("anthropic");
    expect(ep.hasKey).toBe(false);
    expect(ep.id).toBeTruthy();
  });
});

describe("sanitizeEndpoint", () => {
  it("rejects junk and endpoints missing a baseUrl", () => {
    expect(sanitizeEndpoint(null)).toBeNull();
    expect(sanitizeEndpoint({ model: "m" })).toBeNull();
  });

  it("keeps an endpoint whose model isn't chosen yet (Phase 40)", () => {
    // A model-less endpoint is a real state — the vLLM preset ships without one,
    // and clearing the field in the form produces it. Dropping the whole record
    // would silently discard the user's URL and its keychain link; usability is
    // decided by activeEndpoint instead.
    const ep = sanitizeEndpoint({ baseUrl: "http://h/v1", model: "" });
    expect(ep).not.toBeNull();
    expect(ep!.model).toBe("");
  });

  it("keeps a valid endpoint and defaults the provider to openai", () => {
    const ep = sanitizeEndpoint({ baseUrl: "http://h/v1", model: "qwen", provider: "weird" });
    expect(ep).not.toBeNull();
    expect(ep!.provider).toBe("openai");
    expect(ep!.hasKey).toBe(false);
  });
});

describe("sanitizeAiSettings", () => {
  it("drops invalid endpoints and resets a dangling active id", () => {
    const s = sanitizeAiSettings({
      enabled: true,
      activeEndpointId: "gone",
      endpoints: [
        { id: "a", baseUrl: "http://h/v1", model: "qwen", provider: "openai" },
        { baseUrl: "", model: "" }, // dropped
      ],
    });
    expect(s.endpoints).toHaveLength(1);
    expect(s.activeEndpointId).toBe("a"); // falls back to first valid endpoint
  });

  it("falls back to defaults for junk input", () => {
    const s = sanitizeAiSettings(42);
    expect(s.enabled).toBe(false);
    expect(s.endpoints).toEqual([]);
    expect(s.prompts.chat.prompts).toHaveLength(1);
    expect(s.prompts.chat.activeId).toBe(s.prompts.chat.prompts[0].id);
  });

  it("migrates legacy single-string prompts into the new lists", () => {
    const d = defaultAiSettings();
    const custom = sanitizeAiSettings({ chatSystem: "be terse", runbookSystem: "  make steps  " });
    expect(custom.prompts.chat.prompts[0].content).toBe("be terse");
    expect(custom.prompts.runbook.prompts[0].content).toBe("make steps"); // trimmed
    // Blank/missing → built-in default content.
    const blank = sanitizeAiSettings({ chatSystem: "   " });
    expect(blank.prompts.chat.prompts[0].content).toBe(d.prompts.chat.prompts[0].content);
  });

  it("keeps stored prompt lists with a valid active id", () => {
    const s = sanitizeAiSettings({
      prompts: {
        chat: {
          activeId: "p2",
          prompts: [
            { id: "p1", name: "A", content: "one" },
            { id: "p2", name: "B", content: "two" },
          ],
        },
      },
    });
    expect(s.prompts.chat.prompts).toHaveLength(2);
    expect(s.prompts.chat.activeId).toBe("p2");
    // A kind with no stored data still gets its default.
    expect(s.prompts.ansible.prompts).toHaveLength(1);
  });

  it("keeps and cleans stored custom confirm-patterns", () => {
    const s = sanitizeAiSettings({ dangerousPatterns: ["  terraform destroy  ", "", "Kubectl Delete"] });
    expect(s.dangerousPatterns).toEqual(["terraform destroy", "Kubectl Delete"]);
    // Missing → empty (not undefined).
    expect(sanitizeAiSettings({}).dangerousPatterns).toEqual([]);
  });
});

describe("sanitizeDangerousPatterns", () => {
  it("trims, drops empties and de-dupes case-insensitively", () => {
    expect(sanitizeDangerousPatterns(["  rm  ", "", "   ", "RM", "dd"])).toEqual(["rm", "dd"]);
  });

  it("returns [] for non-array / junk", () => {
    expect(sanitizeDangerousPatterns(null)).toEqual([]);
    expect(sanitizeDangerousPatterns("rm")).toEqual([]);
    expect(sanitizeDangerousPatterns(42)).toEqual([]);
  });

  it("clips each pattern length and the whole list count", () => {
    const long = "a".repeat(MAX_DANGEROUS_PATTERN_LEN + 50);
    expect(sanitizeDangerousPatterns([long])[0]).toHaveLength(MAX_DANGEROUS_PATTERN_LEN);
    const many = Array.from({ length: MAX_DANGEROUS_PATTERNS + 20 }, (_, i) => `p${i}`);
    expect(sanitizeDangerousPatterns(many)).toHaveLength(MAX_DANGEROUS_PATTERNS);
  });
});

describe("activeEndpoint / aiReady", () => {
  const ep = { id: "a", name: "L", provider: "openai" as const, baseUrl: "http://h/v1", model: "q", hasKey: false };

  it("is null/false when disabled", () => {
    const s = { ...defaultAiSettings(), endpoints: [ep], activeEndpointId: "a" };
    expect(activeEndpoint(s)).toBeNull();
    expect(aiReady(s)).toBe(false);
  });

  it("resolves the active endpoint when enabled", () => {
    const s = { ...defaultAiSettings(), enabled: true, endpoints: [ep], activeEndpointId: "a" };
    expect(activeEndpoint(s)?.id).toBe("a");
    expect(aiReady(s)).toBe(true);
  });
});

describe("buildChatRequest", () => {
  const ep = { id: "a", name: "L", provider: "openai" as const, baseUrl: "http://h/v1", model: "q", hasKey: false };
  const msgs = [{ role: "user" as const, content: "hi" }];

  it("returns null when AI is off / no active endpoint", () => {
    expect(buildChatRequest(defaultAiSettings(), "s1", msgs)).toBeNull();
  });

  it("builds a request from the active endpoint", () => {
    const s = { ...defaultAiSettings(), enabled: true, endpoints: [ep], activeEndpointId: "a" };
    const req = buildChatRequest(s, "s1", msgs, "sys");
    expect(req).not.toBeNull();
    expect(req!.endpointId).toBe("a");
    expect(req!.baseUrl).toBe("http://h/v1");
    expect(req!.system).toBe("sys");
    expect(req!.maxTokens).toBeUndefined(); // openai leaves it open
  });

  it("sets a default max_tokens for anthropic", () => {
    const anth = { ...ep, provider: "anthropic" as const, baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" };
    const s = { ...defaultAiSettings(), enabled: true, endpoints: [anth], activeEndpointId: "a" };
    expect(buildChatRequest(s, "s1", msgs)!.maxTokens).toBe(4096);
  });

  it("prepends the endpoint base prompt and attaches parsed params", () => {
    const tuned = { ...ep, basePrompt: "You run on Local.", params: '{"temperature":0.2}' };
    const s = { ...defaultAiSettings(), enabled: true, endpoints: [tuned], activeEndpointId: "a" };
    const req = buildChatRequest(s, "s1", msgs, "Chat rules.")!;
    expect(req.system).toBe("You run on Local.\n\nChat rules.");
    expect(req.params).toEqual({ temperature: 0.2 });
  });

  it("omits params when the JSON is blank/invalid", () => {
    const bad = { ...ep, params: "{ not json" };
    const s = { ...defaultAiSettings(), enabled: true, endpoints: [bad], activeEndpointId: "a" };
    expect(buildChatRequest(s, "s1", msgs, "sys")!.params).toBeUndefined();
  });
});

describe("parseParams", () => {
  it("parses a JSON object", () => {
    expect(parseParams('{"temperature":0.3,"top_p":0.9}')).toEqual({ temperature: 0.3, top_p: 0.9 });
  });
  it("returns null for empty, invalid, or non-object JSON", () => {
    expect(parseParams("")).toBeNull();
    expect(parseParams("   ")).toBeNull();
    expect(parseParams("{ oops")).toBeNull();
    expect(parseParams("[1,2]")).toBeNull(); // array is not a params object
    expect(parseParams("42")).toBeNull();
  });
});

describe("resolvePromptContent", () => {
  const set = {
    activeId: "a",
    prompts: [
      { id: "a", name: "Active", content: "active one" },
      { id: "b", name: "Other", content: "other prompt" },
    ],
  };

  it("prefers the prompt with the given id (e.g. a server's chosen one)", () => {
    expect(resolvePromptContent(set, "b", "fb")).toBe("other prompt");
  });

  it("uses the active prompt when the preferred id is missing/null", () => {
    expect(resolvePromptContent(set, "nope", "fb")).toBe("active one");
    expect(resolvePromptContent(set, null, "fb")).toBe("active one");
  });

  it("falls back when the set is empty", () => {
    expect(resolvePromptContent({ activeId: null, prompts: [] }, null, "fb")).toBe("fb");
    expect(resolvePromptContent(undefined, null, "fb")).toBe("fb");
  });
});

describe("effectiveExecMode", () => {
  it("uses a valid per-server override, else the global mode", () => {
    expect(effectiveExecMode("suggest", "confirm")).toBe("suggest");
    expect(effectiveExecMode("dialog", "confirm")).toBe("dialog");
    expect(effectiveExecMode(null, "confirm")).toBe("confirm");
    expect(effectiveExecMode("", "dialogConfirm")).toBe("dialogConfirm");
    // The removed "auto" mode is no longer valid → falls back to the global mode.
    expect(effectiveExecMode("auto", "confirm")).toBe("confirm");
    expect(effectiveExecMode("bogus", "confirm")).toBe("confirm");
  });
});

describe("mergeModelOptions", () => {
  it("unions fetched models with the current one, sorted + deduped", () => {
    expect(mergeModelOptions(["qwen2.5", "llama3"], "qwen2.5")).toEqual(["llama3", "qwen2.5"]);
    // The current model is always present even if not in the fetched list.
    expect(mergeModelOptions(["llama3"], "custom")).toEqual(["custom", "llama3"]);
    // Empties are dropped; empty current is fine.
    expect(mergeModelOptions(["", "a"], "")).toEqual(["a"]);
  });
});

describe("aiErrorKind", () => {
  it("classifies auth failures", () => {
    expect(aiErrorKind("auth-rejected: wrong key")).toBe("auth");
    expect(aiErrorKind("ai endpoint 401: unauthorized")).toBe("auth");
    expect(aiErrorKind(new Error("Permission denied"))).toBe("auth");
  });

  it("classifies unreachable endpoints", () => {
    expect(aiErrorKind("ai-unreachable: error sending request")).toBe("unreachable");
    expect(aiErrorKind("tcp connect error: Connection refused")).toBe("unreachable");
  });

  it("classifies billing / quota failures", () => {
    expect(aiErrorKind("ai endpoint 400: Your credit balance is too low")).toBe("billing");
    expect(aiErrorKind("You exceeded your current quota")).toBe("billing");
  });

  it("classifies rate limits", () => {
    expect(aiErrorKind("ai endpoint 429: rate limit exceeded")).toBe("rate");
  });

  it("falls back to other for anything else", () => {
    expect(aiErrorKind("ai endpoint 500: boom")).toBe("other");
    expect(aiErrorKind("weird")).toBe("other");
  });
});

// ── Phase 40 ────────────────────────────────────────────────────────────────────

/** A conversation of `n` alternating turns, oldest first, each tagged by index. */
function convo(n: number, size = 4): AiChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${i}`.padEnd(size, "."),
  }));
}

describe("trimHistory", () => {
  it("keeps the newest messages up to the message cap", () => {
    const r = trimHistory(convo(10), 4, null);
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0].content).toMatch(/^6/); // 6,7,8,9 survive
    expect(r.dropped).toBe(6);
  });

  it("drops further to respect the character cap", () => {
    // 10 messages × 4 chars = 40; a 12-char cap leaves the last 3 (indices 7,8,9).
    // Index 7 is an assistant turn, so the "never open on assistant" rule then
    // trims one more — the two caps compose rather than fighting.
    const r = trimHistory(convo(10), null, 12);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe("user");
    expect(r.chars).toBeLessThanOrEqual(12);
    expect(r.dropped).toBe(8);
  });

  it("never opens on an assistant turn", () => {
    // Anthropic's /v1/messages rejects a conversation that starts mid-exchange,
    // so a cap landing on an assistant message must slide one further.
    const r = trimHistory(convo(10), 3, null);
    expect(r.messages[0].role).toBe("user");
    expect(r.messages).toHaveLength(2);
  });

  it("always keeps the last message, however oversized", () => {
    // The final turn is the question being asked — sending nothing is worse than
    // sending something too big, which at least produces a real provider error.
    const huge: AiChatMessage[] = [{ role: "user", content: "x".repeat(5000) }];
    const r = trimHistory(huge, 10, 100);
    expect(r.messages).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it("passes everything through when both caps are off", () => {
    const r = trimHistory(convo(50), null, null);
    expect(r.messages).toHaveLength(50);
    expect(r.dropped).toBe(0);
  });

  it("handles an empty conversation", () => {
    expect(trimHistory([], 5, 100)).toEqual({ messages: [], dropped: 0, chars: 0 });
  });
});

describe("sanitizeOptionalInt", () => {
  it("treats blank and junk as 'use the default', not as zero", () => {
    for (const v of ["", "  ", "abc", null, undefined, NaN, 0, -5]) {
      expect(sanitizeOptionalInt(v, MAX_TOKENS_RANGE)).toBeNull();
    }
  });

  it("clamps into range and truncates", () => {
    expect(sanitizeOptionalInt("100", TIMEOUT_RANGE)).toBe(100);
    expect(sanitizeOptionalInt(1, TIMEOUT_RANGE)).toBe(TIMEOUT_RANGE.min);
    expect(sanitizeOptionalInt(99_999, TIMEOUT_RANGE)).toBe(TIMEOUT_RANGE.max);
    expect(sanitizeOptionalInt(12.9, TIMEOUT_RANGE)).toBe(12);
  });
});

describe("buildChatRequest (Phase 40 fields)", () => {
  function ready() {
    const s = defaultAiSettings();
    s.enabled = true;
    const ep = newAiEndpoint("openai");
    s.endpoints = [ep];
    s.activeEndpointId = ep.id;
    return { s, ep };
  }

  it("sends the endpoint's reply cap, and Anthropic's fallback when unset", () => {
    const { s, ep } = ready();
    expect(buildChatRequest(s, "sid", convo(2))!.maxTokens).toBeUndefined();
    ep.maxTokens = 512;
    expect(buildChatRequest(s, "sid", convo(2))!.maxTokens).toBe(512);
    // Anthropic requires the field, so it still gets a value when unset.
    ep.maxTokens = null;
    ep.provider = "anthropic";
    expect(buildChatRequest(s, "sid", convo(2))!.maxTokens).toBe(ANTHROPIC_FALLBACK_MAX_TOKENS);
  });

  it("carries a timeout, defaulting when the endpoint sets none", () => {
    const { s, ep } = ready();
    expect(buildChatRequest(s, "sid", convo(2))!.timeoutSec).toBe(DEFAULT_AI_TIMEOUT_SEC);
    ep.timeoutSec = 30;
    expect(buildChatRequest(s, "sid", convo(2))!.timeoutSec).toBe(30);
  });

  it("trims the history it sends", () => {
    const { s } = ready();
    s.historyLimit = 4;
    s.historyCharCap = null;
    expect(buildChatRequest(s, "sid", convo(20))!.messages).toHaveLength(4);
  });

  it("refuses an endpoint with no model chosen", () => {
    const { s, ep } = ready();
    ep.model = "";
    expect(activeEndpoint(s)).toBeNull();
    expect(aiReady(s)).toBe(false);
    expect(buildChatRequest(s, "sid", convo(2))).toBeNull();
  });
});

describe("history caps in settings", () => {
  it("defaults to capped, and upgrades old settings to the caps", () => {
    expect(defaultAiSettings().historyLimit).toBe(DEFAULT_HISTORY_LIMIT);
    // Settings written before Phase 40 have no such keys; unbounded replay is the
    // defect this phase fixes, so the upgrade opts them in rather than out.
    const old = sanitizeAiSettings({ enabled: true });
    expect(old.historyLimit).toBe(DEFAULT_HISTORY_LIMIT);
    expect(old.historyCharCap).toBe(DEFAULT_HISTORY_CHAR_CAP);
  });

  it("honours an explicit null as 'no cap'", () => {
    const s = sanitizeAiSettings({ historyLimit: null, historyCharCap: null });
    expect(s.historyLimit).toBeNull();
    expect(s.historyCharCap).toBeNull();
  });
});

describe("usageSummary", () => {
  it("formats what was measured", () => {
    const u = usageSummary({ inputTokens: 1240, outputTokens: 386 }, 6100);
    expect(u).toEqual({ input: "1 240", output: "386", elapsed: "6.1 s" });
  });

  it("omits halves the endpoint never reported rather than showing zero", () => {
    const u = usageSummary({ outputTokens: 12 }, undefined);
    expect(u).toEqual({ input: null, output: "12", elapsed: null });
  });

  it("returns null when there is nothing to show", () => {
    expect(usageSummary(undefined, undefined)).toBeNull();
    expect(usageSummary({}, 0)).toBeNull();
  });

  it("formats counts and durations deterministically", () => {
    expect(formatTokens(1_234_567)).toBe("1 234 567");
    expect(formatTokens(42)).toBe("42");
    expect(formatElapsed(800)).toBe("0.8 s");
    expect(formatElapsed(12_400)).toBe("12 s");
    expect(formatElapsed(64_000)).toBe("1:04");
  });
});
