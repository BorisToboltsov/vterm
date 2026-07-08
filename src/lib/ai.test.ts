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
    expect(d.prompts.chat.prompts[0].content).toContain("```bash");
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
  it("rejects junk and endpoints missing baseUrl/model", () => {
    expect(sanitizeEndpoint(null)).toBeNull();
    expect(sanitizeEndpoint({ baseUrl: "x" })).toBeNull();
    expect(sanitizeEndpoint({ model: "m" })).toBeNull();
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
    expect(effectiveExecMode("auto", "confirm")).toBe("auto");
    expect(effectiveExecMode(null, "confirm")).toBe("confirm");
    expect(effectiveExecMode("", "auto")).toBe("auto");
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
