import { describe, expect, it } from "vitest";
import { comesBack, drawnBox, fluidK, glideFrom, morphFrom, rowMoves, spanAt, type Rect, type Span } from "./fluidfit";

describe("fluidK", () => {
  const RING: Span = { max: 64, min: 32 };
  const GAP: Span = { max: 20, min: 12 };
  const parts = [
    [RING, 1],
    [GAP, 2],
  ] as const;
  const need = (k: number, fixed: number) => fixed + spanAt(RING, k) + 2 * spanAt(GAP, k);

  it("is 1 with the room the screen needs at k = 1, and more", () => {
    expect(fluidK(need(1, 50), 50, parts)).toBe(1);
    expect(fluidK(1000, 50, parts)).toBe(1);
  });

  it("solves the k at which the screen needs exactly the room", () => {
    for (const room of [need(0, 50), need(0.25, 50), need(0.8, 50)]) {
      const k = fluidK(room, 50, parts)!;
      expect(need(k, 50)).toBeCloseTo(room, 9);
    }
    expect(fluidK(need(0, 50), 50, parts)).toBe(0);
  });

  it("is null short of k = 0, or without a room to speak of", () => {
    expect(fluidK(need(0, 50) - 0.5, 50, parts)).toBeNull();
    expect(fluidK(Number.NaN, 50, parts)).toBeNull();
  });

  it("is 1 when nothing follows k and the rest fits", () => {
    expect(fluidK(60, 50, [])).toBe(1);
    expect(fluidK(40, 50, [])).toBeNull();
  });
});

describe("spanAt", () => {
  it("runs from min at 0 to max at 1", () => {
    expect(spanAt({ max: 56, min: 36 }, 0)).toBe(36);
    expect(spanAt({ max: 56, min: 36 }, 1)).toBe(56);
    expect(spanAt({ max: 56, min: 36 }, 0.5)).toBe(46);
  });
});

describe("drawnBox", () => {
  const laid = { mid: 100, height: 40 };

  it("is the laid-out box without a transform", () => {
    expect(drawnBox(laid, "none")).toEqual(laid);
    expect(drawnBox(laid, "")).toEqual(laid);
  });

  it("reads the shift and scale of a 2D matrix", () => {
    expect(drawnBox(laid, "matrix(0.5, 0, 0, 0.5, 0, -12)")).toEqual({ mid: 88, height: 20 });
  });

  it("reads them from a 3D matrix too", () => {
    const m = "matrix3d(1.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1, 0, 0, 30, 0, 1)";
    expect(drawnBox(laid, m)).toEqual({ mid: 130, height: 60 });
  });

  it("does not guess at what it cannot read", () => {
    expect(drawnBox(laid, "rotate(10deg)")).toEqual(laid);
    expect(drawnBox(laid, "matrix(a, b)")).toEqual(laid);
  });
});

describe("glideFrom", () => {
  it("moves a block from where it is drawn to where it is laid", () => {
    expect(glideFrom({ mid: 80, height: 20 }, { mid: 60, height: 20 }, false)).toEqual({
      dy: 20,
      scale: 1,
    });
  });

  it("scales only the ring", () => {
    expect(glideFrom({ mid: 50, height: 64 }, { mid: 50, height: 32 }, true)).toEqual({
      dy: 0,
      scale: 2,
    });
    expect(glideFrom({ mid: 50, height: 64 }, { mid: 50, height: 32 }, false)).toBeNull();
  });

  it("has nothing to show for a block that was not drawn, is hidden now, or barely moves", () => {
    expect(glideFrom(undefined, { mid: 1, height: 1 }, false)).toBeNull();
    expect(glideFrom({ mid: 9, height: 0 }, { mid: 1, height: 10 }, false)).toBeNull();
    expect(glideFrom({ mid: 9, height: 10 }, { mid: 1, height: 0 }, false)).toBeNull();
    expect(glideFrom({ mid: 10.3, height: 10 }, { mid: 10, height: 10 }, true)).toBeNull();
  });
});

describe("comesBack", () => {
  it("is a block that was there and hidden, and is drawn now", () => {
    expect(comesBack({ mid: 0, height: 0 }, { mid: 40, height: 64 })).toBe(true);
  });

  it("is not a block that stays drawn, stays hidden, hides, or the fit has not seen", () => {
    expect(comesBack({ mid: 40, height: 64 }, { mid: 40, height: 32 })).toBe(false);
    expect(comesBack({ mid: 0, height: 0 }, { mid: 0, height: 0 })).toBe(false);
    expect(comesBack({ mid: 40, height: 64 }, { mid: 0, height: 0 })).toBe(false);
    expect(comesBack(undefined, { mid: 40, height: 64 })).toBe(false);
  });
});

describe("morphFrom", () => {
  const icon = { x: 10, y: 40, width: 16, height: 16 };

  it("puts the part centre on centre where it was drawn, as wide as it was", () => {
    const badge = { x: 100, y: 0, width: 36, height: 36 };
    expect(morphFrom(badge, icon)).toEqual({ dx: 100, dy: -30, scale: 36 / 16 });
  });

  it("leaves to its block the shift the block's glide carries", () => {
    const badge = { x: 100, y: 0, width: 36, height: 36 };
    expect(morphFrom(badge, icon, -20)).toEqual({ dx: 100, dy: -10, scale: 36 / 16 });
  });

  it("has nothing to show without a place it was drawn, or for a part that stays", () => {
    expect(morphFrom(undefined, icon)).toBeNull();
    expect(morphFrom({ x: 0, y: 0, width: 0, height: 0 }, icon)).toBeNull();
    expect(morphFrom(icon, icon)).toBeNull();
  });
});

describe("rowMoves", () => {
  const box = (x: number, width = 20): Rect => ({ x, y: 0, width, height: 20 });

  it("glides what stays and moved, leaves alone what stayed put", () => {
    const before = new Map([["a", box(0)], ["b", box(30)], ["c", box(60)]]);
    const after = new Map([["a", box(0)], ["b", box(40)], ["c", box(70)]]);
    expect(rowMoves(before, after)).toEqual([
      { kind: "glide", key: "b", dx: -10, dy: 0 },
      { kind: "glide", key: "c", dx: -10, dy: 0 },
    ]);
  });

  it("sends what leaves into «⋯», and takes what comes back out of it", () => {
    const before = new Map([["a", box(0)], ["b", box(30)], ["more", box(60, 16)]]);
    const leaving = rowMoves(before, new Map([["a", box(0)], ["more", box(30, 16)]]), "more");
    expect(leaving).toContainEqual({ kind: "leave", key: "b", from: box(30), to: box(30, 16) });
    const back = rowMoves(new Map([["a", box(0)], ["more", box(30, 16)]]), before, "more");
    expect(back).toContainEqual({ kind: "enter", key: "b", from: box(30, 16), to: box(30) });
  });

  it("lets «⋯» itself only fade, and the last one back come out of where it was", () => {
    const one = new Map([["a", box(0)]]);
    const withMore = new Map([["a", box(0)], ["more", box(30, 16)]]);
    expect(rowMoves(one, withMore, "more")).toEqual([{ kind: "enter", key: "more", from: null, to: box(30, 16) }]);
    // The last item back: «⋯» goes in the same change, it still came out of it.
    const back = rowMoves(new Map([["more", box(0, 16)]]), new Map([["a", box(0)]]), "more");
    expect(back).toEqual([
      { kind: "leave", key: "more", from: box(0, 16), to: null },
      { kind: "enter", key: "a", from: box(0, 16), to: box(0) },
    ]);
  });

  it("fades what leaves a row with no «⋯»", () => {
    expect(rowMoves(new Map([["a", box(0)]]), new Map())).toEqual([
      { kind: "leave", key: "a", from: box(0), to: null },
    ]);
  });
});

