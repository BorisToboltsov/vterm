import { describe, it, expect } from "vitest";
import {
  bufferGrid,
  CARD_ROOM,
  cardTier,
  classifyToken,
  clipText,
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

describe("cardTier", () => {
  it("keeps the card where it has always fitted", () => {
    expect(cardTier(1100, 620)).toBe("full");
    expect(cardTier(CARD_ROOM.wideW, CARD_ROOM.fullH)).toBe("full");
  });
  it("gives a low, wide area the header line with the chart under it", () => {
    // The terminal area under a raised bottom dock: the case the card broke in.
    expect(cardTier(900, 150)).toBe("wide");
    expect(cardTier(900, CARD_ROOM.fullH - 1)).toBe("wide");
    expect(cardTier(900, CARD_ROOM.wideH)).toBe("wide");
  });
  it("drops the chart when the area is lower than a chart is worth", () => {
    expect(cardTier(900, CARD_ROOM.wideH - 1)).toBe("row");
    expect(cardTier(900, 20)).toBe("row");
  });
  it("stacks the numbers in a narrow, tall area", () => {
    expect(cardTier(300, 400)).toBe("stack");
    expect(cardTier(CARD_ROOM.wideW - 1, 900)).toBe("stack");
    expect(cardTier(CARD_ROOM.stackW, CARD_ROOM.stackH)).toBe("stack");
  });
  it("shows the numbers without a chart where a column does not fit", () => {
    expect(cardTier(300, CARD_ROOM.stackH - 1)).toBe("mini");
    expect(cardTier(CARD_ROOM.stackW - 1, 900)).toBe("mini");
    // The smallest pane the centre makes (`PANE_LIMITS`: 240 × 140).
    expect(cardTier(240, 140)).toBe("mini");
    expect(cardTier(CARD_ROOM.miniW, CARD_ROOM.miniH)).toBe("mini");
  });
  it("falls back to the host alone", () => {
    expect(cardTier(CARD_ROOM.miniW - 1, 400)).toBe("line");
    expect(cardTier(300, CARD_ROOM.miniH - 1)).toBe("line");
  });
  it("treats an unmeasured or junk area as the smallest", () => {
    for (const [w, h] of [
      [0, 0],
      [0, 500],
      [800, 0],
      [-5, 300],
      [NaN, 300],
      [800, NaN],
      [Infinity, -1],
    ]) {
      expect(cardTier(w, h)).toBe("line");
    }
  });
  it("never gives an area a layout that needs more room than it has", () => {
    const needs = {
      full: [CARD_ROOM.wideW, CARD_ROOM.fullH],
      wide: [CARD_ROOM.wideW, CARD_ROOM.wideH],
      row: [CARD_ROOM.wideW, 0],
      stack: [CARD_ROOM.stackW, CARD_ROOM.stackH],
      mini: [CARD_ROOM.miniW, CARD_ROOM.miniH],
      line: [0, 0],
    } as const;
    for (let w = 40; w <= 1400; w += 20) {
      for (let h = 20; h <= 900; h += 10) {
        const [minW, minH] = needs[cardTier(w, h)];
        expect(w, `${w}×${h} width`).toBeGreaterThanOrEqual(minW);
        expect(h, `${w}×${h} height`).toBeGreaterThanOrEqual(minH);
      }
    }
  });
  it("only ever grows the layout as the area grows taller", () => {
    // Raising the bottom dock must step the card down, never up and back.
    const rank = { line: 0, row: 0, mini: 1, wide: 2, stack: 2, full: 3 } as const;
    for (const w of [180, 210, 300, 479, 480, 900]) {
      let last = 0;
      for (let h = 10; h <= 900; h += 5) {
        const r = rank[cardTier(w, h)];
        expect(r, `${w}×${h}`).toBeGreaterThanOrEqual(last);
        last = r;
      }
    }
  });
});

describe("clipText", () => {
  it("leaves text that fits alone", () => {
    expect(clipText("db-01", 5)).toBe("db-01");
    expect(clipText("db-01", 40)).toBe("db-01");
    expect(clipText("", 3)).toBe("");
  });
  it("marks the cut with an ellipsis and stays within the limit", () => {
    expect(clipText("db-prod-01.example.com", 10)).toBe("db-prod-0…");
    expect(clipText("db-prod-01", 9.8)).toBe("db-prod-…");
    expect([...clipText("db-prod-01", 1)]).toEqual(["…"]);
  });
  it("gives nothing when nothing fits", () => {
    expect(clipText("db-01", 0)).toBe("");
    expect(clipText("db-01", 0.9)).toBe("");
    expect(clipText("db-01", -3)).toBe("");
    expect(clipText("db-01", NaN)).toBe("");
  });
  it("counts characters, not UTF-16 units", () => {
    expect(clipText("сервер-базы", 7)).toBe("сервер…");
    expect([...clipText("🖥🖥🖥🖥", 3)]).toHaveLength(3);
  });
});
