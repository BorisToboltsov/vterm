import { describe, expect, it } from "vitest";
import {
  CONN_MODES,
  GAP,
  GLYPH,
  PAD_X,
  PAD_Y,
  RING,
  TIGHT,
  layoutFor,
  ringFit,
} from "./connfit";

/** Height the screen needs at `k` — what `ringFit` solves for. */
const need = (k: number, text: number, gaps: number) => {
  const l = layoutFor("ring", k);
  return 2 * l.padY + l.ring + gaps * l.gap + text;
};

describe("ringFit", () => {
  // The checklist of a direct connection: ring, title, steps — two gaps.
  const text = 108;
  const gaps = 2;

  it("draws today's screen when it has the room today's screen needs", () => {
    expect(need(1, text, gaps)).toBe(2 * 24 + 64 + 2 * 20 + text);
    expect(ringFit(need(1, text, gaps), text, gaps)).toBe(1);
    expect(ringFit(1000, text, gaps)).toBe(1);
  });

  it("shrinks the ring with the room, the smallest ring at the least room", () => {
    const least = need(0, text, gaps);
    expect(ringFit(least, text, gaps)).toBe(0);
    const mid = ringFit((least + need(1, text, gaps)) / 2, text, gaps)!;
    expect(mid).toBeCloseTo(0.5, 10);
    // Solved, not approximated: the layout at that k needs exactly the room.
    for (const room of [least, least + 7, least + 31, need(1, text, gaps) - 1]) {
      const k = ringFit(room, text, gaps)!;
      expect(need(k, text, gaps)).toBeCloseTo(room, 9);
    }
  });

  it("is null short of even the smallest ring — the ring gives way, it is never squeezed", () => {
    expect(ringFit(need(0, text, gaps) - 0.5, text, gaps)).toBeNull();
    expect(ringFit(40, text, gaps)).toBeNull();
    expect(ringFit(Number.NaN, text, gaps)).toBeNull();
  });

  it("counts every gap: buttons under the checklist need more room", () => {
    const room = need(0.5, text, 2);
    expect(ringFit(room, text, 3)!).toBeLessThan(ringFit(room, text, 2)!);
  });

  it("only ever grows with the room", () => {
    let last = -1;
    for (let room = 150; room <= 320; room++) {
      const k = ringFit(room, text, gaps) ?? -1;
      expect(k).toBeGreaterThanOrEqual(last);
      last = k;
    }
  });
});

describe("layoutFor", () => {
  it("is today's screen at k = 1 and the smallest ring at k = 0", () => {
    expect(layoutFor("ring", 1)).toEqual({ ring: 64, gap: 20, padY: 24, padX: 24, glyph: 1 });
    expect(layoutFor("ring", 0)).toEqual({
      ring: RING.min,
      gap: GAP.min,
      padY: PAD_Y.min,
      padX: PAD_X.min,
      glyph: GLYPH.min,
    });
  });

  it("keeps k within 0…1", () => {
    expect(layoutFor("ring", 3)).toEqual(layoutFor("ring", 1));
    expect(layoutFor("ring", -2)).toEqual(layoutFor("ring", 0));
    expect(layoutFor("ring", Number.NaN)).toEqual(layoutFor("ring", 1));
  });

  it("lays out the ringless modes tight, whatever k", () => {
    for (const mode of CONN_MODES.filter((m) => m !== "ring")) {
      expect(layoutFor(mode, 1)).toMatchObject(TIGHT);
      expect(layoutFor(mode, 0)).toEqual(layoutFor(mode, 1));
    }
  });

  it("keeps the ring the biggest thing it draws", () => {
    for (let k = 0; k <= 1; k += 0.1) {
      const l = layoutFor("ring", k);
      expect(l.ring).toBeGreaterThan(l.gap);
      expect(22 * l.glyph).toBeLessThan(l.ring / 2);
    }
  });
});
