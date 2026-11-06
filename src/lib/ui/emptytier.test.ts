import { describe, expect, it } from "vitest";
import { BADGE, CTA, EMPTY_TIERS, GAP, GLYPH, PAD_X, PAD_Y, badgeFit, layoutFor } from "./emptytier";

/** Height an empty state needs at `k`, with `text` of text and maybe actions. */
const need = (k: number, text: number, actions: boolean) => {
  const l = layoutFor("badge", k);
  return 2 * l.padY + l.badge + l.gap + text + (actions ? l.cta : 0);
};

describe("layoutFor", () => {
  it("is the v1.30 badge at k = 1 and its medallion at k = 0", () => {
    expect(EMPTY_TIERS).toEqual(["badge", "line", "title"]);
    // The badge: a 56 px circle, a 26 px icon, no lines, p-6, gap-3, actions pt-3.
    expect(layoutFor("badge", 1)).toEqual({ badge: 56, glyph: 1, lines: 0, gap: 12, padY: 24, padX: 24, cta: 12 });
    // The medallion: 36 px, an 18 px icon, the lines grown out, px-4 py-2, gap-2, pt-2.
    expect(layoutFor("badge", 0)).toEqual({
      badge: BADGE.min,
      glyph: GLYPH.min,
      lines: 1,
      gap: GAP.min,
      padY: PAD_Y.min,
      padX: PAD_X.min,
      cta: CTA.min,
    });
    expect(26 * GLYPH.min).toBeCloseTo(18, 9);
  });

  it("grows the lines out of the badge as it shrinks", () => {
    let lines = -1;
    let badge = Infinity;
    for (let k = 1; k >= 0; k -= 0.125) {
      const l = layoutFor("badge", k);
      expect(l.lines).toBeGreaterThan(lines);
      expect(l.badge).toBeLessThan(badge);
      lines = l.lines;
      badge = l.badge;
    }
  });

  it("keeps k within 0…1", () => {
    expect(layoutFor("badge", 4)).toEqual(layoutFor("badge", 1));
    expect(layoutFor("badge", -1)).toEqual(layoutFor("badge", 0));
    expect(layoutFor("badge", Number.NaN)).toEqual(layoutFor("badge", 1));
  });

  it("lays out the badgeless tiers tight, the actions beside the title", () => {
    expect(layoutFor("line")).toMatchObject({ gap: 4, padY: 6, padX: 12, cta: 0 });
    expect(layoutFor("title")).toMatchObject({ gap: 4, padY: 2, padX: 12, cta: 0 });
    expect(layoutFor("line", 0)).toEqual(layoutFor("line", 1));
  });
});

describe("badgeFit", () => {
  const text = 60;

  it("draws the full badge when there is room for it", () => {
    expect(badgeFit(need(1, text, true), text, true)).toBe(1);
    expect(badgeFit(800, text, false)).toBe(1);
  });

  it("solves how far the badge shrinks — the layout then needs exactly the room", () => {
    for (const actions of [false, true]) {
      for (const k of [0, 0.3, 0.75]) {
        const got = badgeFit(need(k, text, actions), text, actions)!;
        expect(got).toBeCloseTo(k, 9);
      }
    }
  });

  it("is null short of the medallion: the badge gives way, it is never squeezed", () => {
    expect(badgeFit(need(0, text, false) - 1, text, false)).toBeNull();
    expect(badgeFit(30, text, true)).toBeNull();
  });

  it("counts the space above the actions only when there are actions", () => {
    const room = need(0.5, text, false);
    expect(badgeFit(room, text, true)!).toBeLessThan(badgeFit(room, text, false)!);
  });
});
