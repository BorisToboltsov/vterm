import { describe, it, expect } from "vitest";
import { bufferGrid, classifyToken, tokenizeBuffer } from "./idlefx";

describe("bufferGrid", () => {
  it("returns exactly rows×cols, padding short lines with spaces", () => {
    const g = bufferGrid("ab\ncde", 4, 3);
    expect(g).toHaveLength(3);
    expect(g.every((r) => r.length === 4)).toBe(true);
    // fewer lines than rows → content is top-aligned, blank row at the bottom
    expect(g[0]).toEqual(["a", "b", " ", " "]);
    expect(g[1]).toEqual(["c", "d", "e", " "]);
    expect(g[2]).toEqual([" ", " ", " ", " "]);
  });
  it("keeps only the last `rows` lines and truncates to cols", () => {
    const g = bufferGrid("one\ntwo\nthree", 2, 2);
    expect(g[0]).toEqual(["t", "w"]);
    expect(g[1]).toEqual(["t", "h"]);
  });
  it("expands tabs to a single space and tolerates zero size", () => {
    expect(bufferGrid("a\tb", 3, 1)[0]).toEqual(["a", " ", "b"]);
    expect(bufferGrid("x", 0, 0)).toEqual([]);
  });
});

describe("classifyToken", () => {
  it("tags keywords, ok-words, numbers and plain", () => {
    expect(classifyToken("prod")).toBe("keyword");
    expect(classifyToken("ERROR")).toBe("keyword");
    expect(classifyToken("running")).toBe("ok");
    expect(classifyToken("200")).toBe("ok");
    expect(classifyToken("41ms")).toBe("number");
    expect(classifyToken("3.14")).toBe("number");
    expect(classifyToken("server")).toBe("plain");
  });
});

describe("tokenizeBuffer", () => {
  it("dedupes, drops 1-char noise, and strips edge punctuation", () => {
    const toks = tokenizeBuffer("$ deploy deploy prod-web-01, ok!");
    const words = toks.map((t) => t.text);
    expect(words).toContain("deploy");
    expect(words.filter((w) => w === "deploy")).toHaveLength(1); // deduped
    expect(words).toContain("prod-web-01");
    expect(words).toContain("ok");
    expect(words).not.toContain("$"); // 1-char dropped
  });
  it("carries the semantic class through", () => {
    const map = new Map(tokenizeBuffer("deploy running 200 host").map((t) => [t.text, t.kind]));
    expect(map.get("deploy")).toBe("keyword");
    expect(map.get("running")).toBe("ok");
    expect(map.get("200")).toBe("ok");
    expect(map.get("host")).toBe("plain");
  });
});
