import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOTION_BASE,
  MOTION_FAST,
  motion,
  motionMs,
  motionScale,
  prefersReducedMotion,
} from "./motion";

/** Installs a matchMedia stub reporting the given reduced-motion preference. */
function stubMatchMedia(reduce: boolean) {
  const fn = vi.fn((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce") && reduce,
    media: query,
  }));
  vi.stubGlobal("matchMedia", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("motionMs", () => {
  it("keeps the requested duration when motion is allowed", () => {
    expect(motionMs(MOTION_FAST, false)).toBe(120);
    expect(motionMs(MOTION_BASE, false)).toBe(200);
  });

  it("collapses to zero under reduced motion", () => {
    expect(motionMs(MOTION_FAST, true)).toBe(0);
    expect(motionMs(MOTION_BASE, true)).toBe(0);
  });

  it("treats nonsensical durations as no animation rather than passing them to WAAPI", () => {
    expect(motionMs(-40, false)).toBe(0);
    expect(motionMs(Number.NaN, false)).toBe(0);
    expect(motionMs(Number.POSITIVE_INFINITY, false)).toBe(0);
  });
});

describe("prefersReducedMotion", () => {
  it("reports the media query result", () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("is false where matchMedia is unavailable (SSR/tests), so the UI still animates", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("transition params", () => {
  it("motion() carries the token duration by default", () => {
    stubMatchMedia(false);
    expect(motion()).toEqual({ duration: MOTION_FAST });
    expect(motion(MOTION_BASE)).toEqual({ duration: MOTION_BASE });
  });

  it("motion() is zero-duration under reduced motion — this is the guard CSS cannot do", () => {
    stubMatchMedia(true);
    expect(motion().duration).toBe(0);
    expect(motion(MOTION_BASE).duration).toBe(0);
  });

  it("re-reads the preference on every call (Svelte re-evaluates params per run)", () => {
    const fn = stubMatchMedia(false);
    motion();
    motion();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("motionScale keeps the lift subtle and fades in from transparent", () => {
    stubMatchMedia(false);
    const p = motionScale();
    expect(p.duration).toBe(MOTION_FAST);
    expect(p.opacity).toBe(0);
    expect(p.start).toBeGreaterThan(0.9);
    expect(p.start).toBeLessThan(1);
  });

  it("motionScale also collapses under reduced motion", () => {
    stubMatchMedia(true);
    expect(motionScale().duration).toBe(0);
  });
});
