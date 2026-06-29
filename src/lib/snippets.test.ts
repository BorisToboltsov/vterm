import { describe, expect, it } from "vitest";
import {
  defaultSnippets,
  snippetsForLang,
  sanitizeSnippets,
  newSnippet,
  type Snippet,
} from "./snippets";

describe("defaultSnippets", () => {
  it("has unique ids and non-empty bodies/names", () => {
    const s = defaultSnippets();
    expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
    expect(s.every((x) => x.body.length > 0 && x.name.length > 0)).toBe(true);
  });

  it("returns a fresh copy each call (editing one doesn't affect another)", () => {
    const a = defaultSnippets();
    a[0].name = "changed";
    expect(defaultSnippets()[0].name).not.toBe("changed");
  });
});

describe("snippetsForLang", () => {
  const list: Snippet[] = [
    { id: "1", name: "y", lang: "yaml", body: "a" },
    { id: "2", name: "d", lang: "dockerfile", body: "b" },
    { id: "3", name: "any", lang: null, body: "c" },
  ];

  it("returns matching-language snippets plus universal ones", () => {
    expect(snippetsForLang("yaml", list).map((s) => s.id)).toEqual(["1", "3"]);
    expect(snippetsForLang("dockerfile", list).map((s) => s.id)).toEqual(["2", "3"]);
    // Unknown language → only the universal ones.
    expect(snippetsForLang("rust", list).map((s) => s.id)).toEqual(["3"]);
  });

  it("works against the built-in defaults (nginx/dockerfile present)", () => {
    const all = defaultSnippets();
    expect(snippetsForLang("nginx", all).length).toBeGreaterThan(0);
    expect(snippetsForLang("dockerfile", all).length).toBeGreaterThan(0);
  });
});

describe("sanitizeSnippets", () => {
  it("drops malformed entries and normalises unknown languages to null", () => {
    const out = sanitizeSnippets([
      { id: "a", name: "ok", lang: "yaml", body: "x" },
      { name: "no body" }, // dropped — no body string
      { id: "b", name: "weird lang", lang: "florp", body: "y" }, // lang → null
      "garbage", // dropped
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].lang).toBe("yaml");
    expect(out[1].lang).toBeNull();
  });

  it("falls back to defaults for non-arrays", () => {
    expect(sanitizeSnippets("nope").length).toBe(defaultSnippets().length);
  });
});

describe("newSnippet", () => {
  it("makes a blank snippet with a fresh id", () => {
    const a = newSnippet();
    const b = newSnippet();
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ name: "", lang: null, body: "" });
  });
});
