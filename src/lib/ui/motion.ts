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
// the lint rule `vterm/motion-duration` keeps that true for transitions added later.
//
// Whether to move at all is the user's call first (v1.35, ADR 0066): the setting
// "Animations" — as the system says (default), always, or never. Windows reports
// reduced motion whenever "Animation effects" is off, which a VM, a remote
// desktop or "best performance" turn off without anyone asking for it, and the
// whole app went still there. The choice rides on `<html data-animations>` (the
// settings store and the first frame in app.html put it there), so this module —
// pure, no store — reads it with the system's answer each time it is asked. CSS
// keys on the result, `<html data-motion="reduce">`, never on the media query.

/** How the app moves: as the system asks, always, or never (`settings.animations`). */
export const ANIMATION_MODES = ["system", "on", "off"] as const;
export type AnimationMode = (typeof ANIMATION_MODES)[number];
export const DEFAULT_ANIMATIONS: AnimationMode = "system";

/** localStorage key read by the boot script in `app.html`: the first frame already
 *  moves — or keeps still — as the user chose. */
export const ANIMATIONS_KEY = "vterm.animations";

/** The system's own reduced-motion query; read here and in app.html, nowhere else. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** A stored value made safe to use: one of the modes, anything else the default. */
export function sanitizeAnimationMode(raw: unknown): AnimationMode {
  return (ANIMATION_MODES as readonly unknown[]).includes(raw) ? (raw as AnimationMode) : DEFAULT_ANIMATIONS;
}

/** Whether the app keeps still: the user's choice, and the system's when the choice is its. */
export function motionReduced(mode: AnimationMode, systemReduces: boolean): boolean {
  return mode === "off" || (mode === "system" && systemReduces);
}

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

/** Whether the system asks for reduced motion (false where matchMedia is absent). */
export function systemReducesMotion(): boolean {
  if (typeof globalThis.matchMedia !== "function") return false;
  return globalThis.matchMedia(REDUCED_MOTION_QUERY)?.matches === true;
}

/** Calls `fn` with the system's answer whenever it changes; returns the stop. Nothing
 *  where matchMedia is absent — there is no answer to follow. */
export function onSystemMotion(fn: (reduces: boolean) => void): () => void {
  if (typeof globalThis.matchMedia !== "function") return () => {};
  const query = globalThis.matchMedia(REDUCED_MOTION_QUERY);
  if (typeof query?.addEventListener !== "function") return () => {};
  const heard = () => fn(query.matches);
  query.addEventListener("change", heard);
  return () => query.removeEventListener("change", heard);
}

/** The user's choice as the document carries it; the default before anything set it. */
export function animationMode(): AnimationMode {
  return sanitizeAnimationMode(globalThis.document?.documentElement?.dataset.animations);
}

/**
 * Whether the app keeps still right now: the choice and the system's answer, read
 * on every call — a transition, a count, a glide asks it as it starts, so a change
 * of either takes effect from the next one.
 */
export function reducedMotion(): boolean {
  return motionReduced(animationMode(), systemReducesMotion());
}

/**
 * Params for a plain `fade`/`slide` transition. Svelte re-evaluates transition
 * params each time the transition runs, so the preference is re-read on every
 * open/close rather than frozen at module load.
 */
export function motion(base: number = MOTION_FAST): { duration: number } {
  return { duration: motionMs(base, reducedMotion()) };
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
