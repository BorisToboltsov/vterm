import { describe, it, expect, beforeEach } from "vitest";
import { defaultPromptFor, isShippedDefault, PROMPT_LOCALES } from "./aiprompts";
import {
  AI_PROMPT_KINDS,
  defaultPrompt,
  defaultAiSettings,
  sanitizeAiSettings,
  newAiPrompt,
  reseedBuiltinPrompts,
} from "./ai";

beforeEach(() => localStorage.clear());

describe("shipped prompts", () => {
  it("covers every kind in every locale", () => {
    for (const locale of PROMPT_LOCALES) {
      for (const kind of AI_PROMPT_KINDS) {
        expect(defaultPromptFor(kind, locale).trim(), `${locale}/${kind}`).not.toBe("");
      }
    }
  });

  it("falls back to English for a locale we don't ship", () => {
    for (const kind of AI_PROMPT_KINDS) {
      expect(defaultPromptFor(kind, "zz")).toBe(defaultPromptFor(kind, "en"));
    }
  });

  it("keeps the machine-readable output contract in every localisation", () => {
    // The generators are parsed by the app (or pasted verbatim), so the fence
    // language must survive translation even though the prose does not.
    for (const locale of PROMPT_LOCALES) {
      expect(defaultPromptFor("sh", locale)).toContain("```bash");
      expect(defaultPromptFor("ansible", locale)).toContain("```yaml");
      expect(defaultPromptFor("runbook", locale)).toContain("```bash");
    }
  });

  it("recognises a shipped default from any locale", () => {
    expect(isShippedDefault("chat", defaultPromptFor("chat", "ru"))).toBe(true);
    expect(isShippedDefault("chat", defaultPromptFor("chat", "en"))).toBe(true);
    expect(isShippedDefault("chat", "be terse")).toBe(false);
    // Kind-specific: the runbook text is not the chat default.
    expect(isShippedDefault("chat", defaultPromptFor("runbook", "en"))).toBe(false);
  });
});

describe("prompt origin", () => {
  it("marks freshly seeded prompts as builtin", () => {
    expect(newAiPrompt("chat").origin).toBe("builtin");
    for (const kind of AI_PROMPT_KINDS) {
      expect(defaultAiSettings().prompts[kind].prompts[0].origin).toBe("builtin");
    }
  });

  it("infers origin for prompts stored before the field existed", () => {
    // Settings written by Phase 40 and earlier carry no `origin`. Content that
    // matches a shipped default is untouched; anything else is the user's.
    const s = sanitizeAiSettings({
      prompts: {
        chat: {
          activeId: "a",
          prompts: [
            { id: "a", name: "Default", content: defaultPromptFor("chat", "en") },
            { id: "b", name: "Mine", content: "Answer only in haiku." },
          ],
        },
      },
    });
    expect(s.prompts.chat.prompts[0].origin).toBe("builtin");
    expect(s.prompts.chat.prompts[1].origin).toBe("custom");
  });

  it("trusts a stored origin over content matching", () => {
    // A user who typed the default text verbatim still owns it.
    const s = sanitizeAiSettings({
      prompts: {
        chat: {
          activeId: "a",
          prompts: [
            { id: "a", name: "D", content: defaultPromptFor("chat", "en"), origin: "custom" },
          ],
        },
      },
    });
    expect(s.prompts.chat.prompts[0].origin).toBe("custom");
  });

  it("treats text migrated out of the legacy flat field as the user's", () => {
    const s = sanitizeAiSettings({ chatSystem: "Always answer in one line." });
    expect(s.prompts.chat.prompts[0].origin).toBe("custom");
    expect(s.prompts.chat.prompts[0].content).toBe("Always answer in one line.");
  });
});

describe("reseedBuiltinPrompts", () => {
  it("re-seeds untouched prompts and leaves edited ones alone", () => {
    const s = defaultAiSettings();
    s.prompts.chat.prompts.push({
      id: "mine",
      name: "Mine",
      content: "Answer only in haiku.",
      origin: "custom",
    });

    const next = reseedBuiltinPrompts(s.prompts, "ru");

    expect(next.chat.prompts[0].content).toBe(defaultPromptFor("chat", "ru"));
    // The user's text survives a language change — the reason `origin` exists.
    expect(next.chat.prompts[1].content).toBe("Answer only in haiku.");
    expect(next.runbook.prompts[0].content).toBe(defaultPromptFor("runbook", "ru"));
  });

  it("keeps ids and the active selection", () => {
    const s = defaultAiSettings();
    const id = s.prompts.chat.prompts[0].id;
    const next = reseedBuiltinPrompts(s.prompts, "ru");
    expect(next.chat.prompts[0].id).toBe(id);
    expect(next.chat.activeId).toBe(id);
  });

  it("survives a kind missing from stored settings", () => {
    // Settings written before a kind existed simply have no entry for it; the
    // re-seed must fill it rather than hand back `undefined`.
    const partial: Record<string, unknown> = { ...defaultAiSettings().prompts };
    delete partial.commit;
    const next = reseedBuiltinPrompts(
      partial as Parameters<typeof reseedBuiltinPrompts>[0],
      "en",
    );
    expect(next.commit.prompts).toHaveLength(1);
  });
});

describe("defaultPrompt", () => {
  it("follows the stored UI language", () => {
    localStorage.setItem("vterm.settings", JSON.stringify({ language: "ru" }));
    expect(defaultPrompt("chat")).toBe(defaultPromptFor("chat", "ru"));
  });

  it("falls back to English when storage has no language", () => {
    expect(defaultPrompt("chat")).toBe(defaultPromptFor("chat", "en"));
  });
});
