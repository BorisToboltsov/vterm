import { describe, expect, it } from "vitest";
import { SNIPPETS, snippetsForLang } from "./snippets";

describe("snippetsForLang", () => {
  it("returns snippets targeting the language", () => {
    const yaml = snippetsForLang("yaml").map((s) => s.id);
    expect(yaml).toContain("compose-service");
    expect(yaml).toContain("k8s-deployment");
    expect(yaml).not.toContain("dockerfile");
    expect(snippetsForLang("shell").map((s) => s.id)).toContain("bash-header");
    expect(snippetsForLang("dockerfile").map((s) => s.id)).toContain("dockerfile");
  });

  it("returns nothing for a language with no snippets", () => {
    expect(snippetsForLang("rust")).toEqual([]);
  });

  it("every snippet has a non-empty unique id and body", () => {
    const ids = new Set(SNIPPETS.map((s) => s.id));
    expect(ids.size).toBe(SNIPPETS.length);
    expect(SNIPPETS.every((s) => s.body.length > 0 && s.name.length > 0)).toBe(true);
  });
});
