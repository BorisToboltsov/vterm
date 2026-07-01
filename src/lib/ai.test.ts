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
} from "./ai";

describe("ai defaults", () => {
  it("is opt-in (disabled) with no endpoints by default", () => {
    const d = defaultAiSettings();
    expect(d.enabled).toBe(false);
    expect(d.endpoints).toEqual([]);
    expect(d.activeEndpointId).toBeNull();
    expect(d.execMode).toBe("confirm");
    expect(d.contract).toBe("markdown");
    // Editable prompts default to the built-in instructions.
    expect(d.chatSystem).toContain("```bash");
    expect(d.runbookSystem.toLowerCase()).toContain("runbook");
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
    expect(sanitizeAiSettings(42)).toEqual(defaultAiSettings());
  });

  it("keeps custom system prompts but falls back when blank/missing", () => {
    const d = defaultAiSettings();
    const custom = sanitizeAiSettings({ chatSystem: "be terse", runbookSystem: "  make steps  " });
    expect(custom.chatSystem).toBe("be terse");
    expect(custom.runbookSystem).toBe("make steps");

    const blank = sanitizeAiSettings({ chatSystem: "   ", runbookSystem: undefined });
    expect(blank.chatSystem).toBe(d.chatSystem);
    expect(blank.runbookSystem).toBe(d.runbookSystem);
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
});
