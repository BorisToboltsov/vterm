import { describe, it, expect } from "vitest";
import {
  bufferGrid,
  classifyToken,
  idleSample,
  loadFraction,
  pushSample,
  seriesRuns,
  tokenizeBuffer,
  type IdleSample,
} from "./idlefx";

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

describe("away card chart", () => {
  it("loadFraction reads load against the core count, capped at 1", () => {
    expect(loadFraction(2, 8)).toBe(0.25);
    expect(loadFraction(16, 8)).toBe(1);
  });

  it("loadFraction is unknown without a load average or a core count", () => {
    // Windows has no load average; never draw it as an idle 0.
    expect(loadFraction(null, 8)).toBeNull();
    expect(loadFraction(1, null)).toBeNull();
    expect(loadFraction(1, 0)).toBeNull();
    expect(loadFraction(Number.NaN, 4)).toBeNull();
  });

  it("idleSample turns percentages into fractions and keeps unknowns null", () => {
    expect(idleSample(50, 25, 1, 4)).toEqual({ cpu: 0.5, mem: 0.25, load: 0.25 });
    expect(idleSample(null, 120, null, 4)).toEqual({ cpu: null, mem: 1, load: null });
  });

  it("pushSample keeps the newest `cap` samples", () => {
    const s = (cpu: number): IdleSample => ({ cpu, mem: null, load: null });
    let h = [s(0.1)];
    h = pushSample(h, s(0.2), 2);
    h = pushSample(h, s(0.3), 2);
    expect(h.map((x) => x.cpu)).toEqual([0.2, 0.3]);
  });

  it("seriesRuns puts 1 at the top edge and 0 at the bottom", () => {
    const [run] = seriesRuns([0, 1], 10, 100, 200, 50);
    expect(run).toEqual([
      { x: 10, y: 150 },
      { x: 210, y: 100 },
    ]);
  });

  it("seriesRuns breaks the line at unknown samples instead of dropping to 0", () => {
    const runs = seriesRuns([0.5, null, 0.5, 0.5], 0, 0, 30, 10);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(1);
    expect(runs[1].map((p) => p.x)).toEqual([20, 30]);
    expect(seriesRuns([null, null], 0, 0, 10, 10)).toEqual([]);
  });
});
