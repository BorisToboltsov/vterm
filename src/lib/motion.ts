// Motion helpers for Svelte transitions (Phase 42).
//
// Why this module has to exist. The design system's rule is "respect
// `prefers-reduced-motion` — the global guard in app.css collapses animations,
// don't introduce movement around it". That guard works by forcing
// `animation-duration`/`transition-duration` to ~0, which covers every CSS
// animation we write by hand. It does NOT cover Svelte transitions: Svelte 5
// drives `transition:`/`in:`/`out:` through the Web Animations API
// (`element.animate(...)`, see svelte/src/internal/client/dom/elements/transitions.js),
// and WAAPI animations are not styled by CSS, so no `!important` in a stylesheet
// can shorten them. Svelte ships `prefersReducedMotion` in `svelte/motion` but its
// transitions do not consult it.
//
// So every `transition:slide`/`in:fade` written before this phase animated at full
// duration even for a user who had asked the OS for no motion — silently, because
// the guard *looks* like it covers everything. The fix is to make the duration
// itself reduce-motion-aware and route every transition directive through here;
// `motion.guard.test.ts` keeps that true for transitions added later.

/** Short transition (row states, dialog entry) — mirrors `--motion-fast` in app.css. */
export const MOTION_FAST = 120;
/** Standard transition (collapse/expand) — mirrors `--motion-base` in app.css. */
export const MOTION_BASE = 200;

/**
 * Duration a transition should actually run for. Pure so the collapse rule is
 * testable without a DOM: reduced motion means "no movement", i.e. 0ms — the
 * element still appears/disappears, it just does so instantly.
 */
export function motionMs(base: number, reduced: boolean): number {
  if (reduced) return 0;
  return Number.isFinite(base) && base > 0 ? base : 0;
}

/** Reads the OS/browser reduced-motion preference (false where matchMedia is absent). */
export function prefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== "function") return false;
  return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Params for a plain `fade`/`slide` transition. Svelte re-evaluates transition
 * params each time the transition runs, so the preference is re-read on every
 * open/close rather than frozen at module load.
 */
export function motion(base: number = MOTION_FAST): { duration: number } {
  return { duration: motionMs(base, prefersReducedMotion()) };
}

/**
 * Params for the dialog-entry `scale` transition: a barely-there lift plus fade.
 * The scale start is close to 1 on purpose — a dialog that zooms reads as a
 * notification, and this UI is meant to stay quiet.
 */
export function motionScale(base: number = MOTION_FAST): {
  duration: number;
  start: number;
  opacity: number;
} {
  return { ...motion(base), start: 0.97, opacity: 0 };
}
