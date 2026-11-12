import { afterEach, describe, expect, it, vi } from "vitest";
import {
  animationMode,
  ANIMATION_MODES,
  DEFAULT_ANIMATIONS,
  MOTION_BASE,
  MOTION_FAST,
  motion,
  motionMs,
  motionReduced,
  motionScale,
  onSystemMotion,
  reducedMotion,
  sanitizeAnimationMode,
  systemReducesMotion,
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

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.animations;
});

/** The user's choice, as the settings store puts it on the document. */
const choose = (mode: string) => (document.documentElement.dataset.animations = mode);

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

describe("systemReducesMotion", () => {
  it("reports the media query result", () => {
    stubMatchMedia(true);
    expect(systemReducesMotion()).toBe(true);
    stubMatchMedia(false);
    expect(systemReducesMotion()).toBe(false);
  });

  it("is false where matchMedia is unavailable (SSR/tests), so the UI still animates", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(systemReducesMotion()).toBe(false);
  });
});

describe("the choice of animations (ADR 0066)", () => {
  it("keeps still when the user said so, or when the choice is the system's and it asks", () => {
    expect(motionReduced("off", false)).toBe(true);
    expect(motionReduced("off", true)).toBe(true);
    expect(motionReduced("on", true)).toBe(false);
    expect(motionReduced("on", false)).toBe(false);
    expect(motionReduced("system", true)).toBe(true);
    expect(motionReduced("system", false)).toBe(false);
  });

  it("takes only a known mode from storage — anything else is the system's say", () => {
    for (const m of ANIMATION_MODES) expect(sanitizeAnimationMode(m)).toBe(m);
    expect(DEFAULT_ANIMATIONS).toBe("system");
    for (const junk of [undefined, null, "", "ON", true, 1, {}]) expect(sanitizeAnimationMode(junk)).toBe("system");
  });

  it("reads the choice off the document, the system's before anything set it", () => {
    expect(animationMode()).toBe("system");
    choose("off");
    expect(animationMode()).toBe("off");
    choose("bogus");
    expect(animationMode()).toBe("system");
  });

  it("decides with both: “always” moves on a still system, “off” stills a moving one", () => {
    stubMatchMedia(true);
    expect(reducedMotion()).toBe(true);
    choose("on");
    expect(reducedMotion()).toBe(false);
    stubMatchMedia(false);
    choose("off");
    expect(reducedMotion()).toBe(true);
    choose("system");
    expect(reducedMotion()).toBe(false);
  });

  it("hears the system's switch until stopped, and nothing where there is no query", () => {
    const listeners = new Set<() => void>();
    let matches = false;
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    }));
    const heard: boolean[] = [];
    const stop = onSystemMotion((r) => heard.push(r));
    matches = true;
    for (const f of listeners) f();
    expect(heard).toEqual([true]);
    stop();
    expect(listeners.size).toBe(0);
    vi.stubGlobal("matchMedia", undefined);
    expect(() => onSystemMotion(() => {})()).not.toThrow();
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

  it("follows the user's choice over the system's", () => {
    stubMatchMedia(true);
    choose("on");
    expect(motion().duration).toBe(MOTION_FAST);
    stubMatchMedia(false);
    choose("off");
    expect(motion(MOTION_BASE).duration).toBe(0);
  });
});
