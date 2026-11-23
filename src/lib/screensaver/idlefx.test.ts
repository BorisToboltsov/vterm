import { describe, it, expect } from "vitest";
import { bufferGrid, CARD_ROOM, cardTier, classifyToken, clipText, tokenizeBuffer } from "./idlefx";

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

describe("cardTier", () => {
  it("fills a large area with the standby screen, a middling one with its short form", () => {
    // A window maximised on a 27″ monitor, docks open: the card used to sit in
    // the middle at 560×320, a twelfth of the area (v1.31).
    expect(cardTier(1920, 1140)).toBe("standby");
    expect(cardTier(CARD_ROOM.standbyW, CARD_ROOM.standbyH)).toBe("standby");
    expect(cardTier(CARD_ROOM.standbyW - 1, 1140)).toBe("compact");
    expect(cardTier(1920, CARD_ROOM.standbyH - 1)).toBe("compact");
    // The default window with docks (1280×800 → 760×460).
    expect(cardTier(760, 460)).toBe("compact");
    expect(cardTier(CARD_ROOM.compactW, CARD_ROOM.compactH)).toBe("compact");
  });
  it("draws the small form where the short one does not fit (ADR 0082)", () => {
    // Half a laptop's window, a 2×2 split, an area under a raised bottom dock.
    expect(cardTier(CARD_ROOM.compactW - 1, 620)).toBe("small");
    expect(cardTier(1100, CARD_ROOM.compactH - 1)).toBe("small");
    expect(cardTier(560, 360)).toBe("small");
    expect(cardTier(900, 150)).toBe("small");
    expect(cardTier(CARD_ROOM.columnW, CARD_ROOM.narrowH)).toBe("small");
    // The smallest pane the centre makes (`PANE_LIMITS`: 240 × 140).
    expect(cardTier(240, 140)).toBe("small");
    expect(cardTier(CARD_ROOM.smallW, CARD_ROOM.smallH)).toBe("small");
  });
  it("stands a narrow, tall area in a column", () => {
    expect(cardTier(330, 560)).toBe("narrow");
    expect(cardTier(CARD_ROOM.columnW - 1, 900)).toBe("narrow");
    expect(cardTier(CARD_ROOM.smallW, CARD_ROOM.narrowH)).toBe("narrow");
    expect(cardTier(330, CARD_ROOM.narrowH - 1)).toBe("small");
  });
  it("falls back to the host and its verdict", () => {
    expect(cardTier(CARD_ROOM.smallW - 1, 400)).toBe("line");
    expect(cardTier(900, CARD_ROOM.smallH - 1)).toBe("line");
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
      [Infinity, 900],
    ]) {
      expect(cardTier(w, h)).toBe("line");
    }
  });
  it("never gives an area a layout that needs more room than it has", () => {
    const needs = {
      standby: [CARD_ROOM.standbyW, CARD_ROOM.standbyH],
      compact: [CARD_ROOM.compactW, CARD_ROOM.compactH],
      small: [CARD_ROOM.smallW, CARD_ROOM.smallH],
      narrow: [CARD_ROOM.smallW, CARD_ROOM.narrowH],
      line: [0, 0],
    } as const;
    for (let w = 40; w <= 2000; w += 20) {
      for (let h = 20; h <= 1200; h += 10) {
        const [minW, minH] = needs[cardTier(w, h)];
        expect(w, `${w}×${h} width`).toBeGreaterThanOrEqual(minW);
        expect(h, `${w}×${h} height`).toBeGreaterThanOrEqual(minH);
      }
    }
  });
  it("only ever grows the layout as the area grows taller", () => {
    // Raising the bottom dock must step the card down, never up and back.
    const rank = { line: 0, small: 1, narrow: 2, compact: 3, standby: 4 } as const;
    for (const w of [180, 210, 300, 479, 480, 599, 600, 900, 1099, 1100, 1920]) {
      let last = 0;
      for (let h = 10; h <= 1200; h += 5) {
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
