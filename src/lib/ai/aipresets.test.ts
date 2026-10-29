import { describe, it, expect } from "vitest";
import { AI_PRESETS, presetsOfKind, presetById, endpointFromPreset } from "./aipresets";
import { sanitizeEndpoint } from "./ai";

describe("AI endpoint presets (Phase 40)", () => {
  it("keeps every preset on one of the two real transports", () => {
    // The point of the registry: vendors are data, not a third provider branch
    // in the Rust broker. A preset naming an unknown provider would reach code
    // that doesn't exist.
    for (const p of AI_PRESETS) {
      expect(["openai", "anthropic"]).toContain(p.provider);
    }
  });

  it("has unique ids and labels", () => {
    expect(new Set(AI_PRESETS.map((p) => p.id)).size).toBe(AI_PRESETS.length);
    expect(new Set(AI_PRESETS.map((p) => p.label)).size).toBe(AI_PRESETS.length);
  });

  it("points every preset at an absolute http(s) base url", () => {
    for (const p of AI_PRESETS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      // The broker appends `/chat/completions`, so a trailing slash would produce
      // a double-slash path on servers that don't normalise it.
      expect(p.baseUrl.endsWith("/")).toBe(false);
    }
  });

  it("marks cloud presets as needing a key and local ones as not", () => {
    for (const p of presetsOfKind("cloud")) expect(p.needsKey).toBe(true);
    for (const p of presetsOfKind("local")) expect(p.needsKey).toBe(false);
    expect(presetsOfKind("local").length).toBeGreaterThan(0);
    expect(presetsOfKind("cloud").length).toBeGreaterThan(0);
  });

  it("does not ship the DeepSeek models deprecated on 2026-07-24", () => {
    const ds = presetById("deepseek");
    expect(ds).not.toBeNull();
    expect(["deepseek-chat", "deepseek-reasoner"]).not.toContain(ds!.model);
  });

  it("returns null for an unknown id", () => {
    expect(presetById("no-such-vendor")).toBeNull();
  });

  it("builds a fresh endpoint per use, so two share no keychain entry", () => {
    const p = presetById("deepseek")!;
    const a = endpointFromPreset(p);
    const b = endpointFromPreset(p);
    expect(a.id).not.toBe(b.id);
    expect(a.baseUrl).toBe(p.baseUrl);
    expect(a.model).toBe(p.model);
    expect(a.hasKey).toBe(false);
  });

  it("produces endpoints that survive a settings round-trip", () => {
    // Including vLLM, whose model is deliberately empty — if sanitize dropped it,
    // picking that preset would look like the button did nothing after a reload.
    for (const p of AI_PRESETS) {
      const round = sanitizeEndpoint(JSON.parse(JSON.stringify(endpointFromPreset(p))));
      expect(round, p.id).not.toBeNull();
      expect(round!.baseUrl).toBe(p.baseUrl);
    }
  });
});
