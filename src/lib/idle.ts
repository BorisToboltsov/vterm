// Idle-screensaver subsystem — pure logic (Phase 0.28 "Заставки простоя").
//
// The overlay component ([IdleOverlay.svelte](./IdleOverlay.svelte)) drives the
// timers and canvas; everything decidable without the DOM lives here so it can be
// tested (idle.test.ts). See docs/INVARIANTS.md — the overlay is painted ON TOP of
// the WebGL terminal (never into the PTY) by the same pattern as ThemeOverlay.

/** A concrete screensaver effect (excludes the "off" sentinel). */
export type IdleEffectId = "card" | "matrix" | "parallax" | "signal";

/** The persisted setting: a concrete effect, or "off" (no screensaver). */
export type IdleSetting = "off" | IdleEffectId;

/** Effects offered in Settings, in display order. */
export const IDLE_EFFECTS: IdleEffectId[] = ["card", "matrix", "parallax", "signal"];

export const DEFAULT_IDLE_EFFECT: IdleSetting = "card";

/** Idle timeout bounds and default (seconds). */
export const DEFAULT_IDLE_TIMEOUT = 180; // 3 minutes
export const IDLE_TIMEOUT_MIN = 15;
export const IDLE_TIMEOUT_MAX = 3600;

/** True for any valid persisted idle setting ("off" or a known effect). */
export function isIdleSetting(v: unknown): v is IdleSetting {
  return v === "off" || (IDLE_EFFECTS as string[]).includes(v as string);
}

/** Clamp/repair a stored idle-timeout value to a sane whole-second range. */
export function clampIdleTimeout(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : DEFAULT_IDLE_TIMEOUT;
  return Math.min(IDLE_TIMEOUT_MAX, Math.max(IDLE_TIMEOUT_MIN, n));
}

/**
 * Idle iff there has been no activity for at least `timeoutSec`. "Activity" is
 * any user input, pointer move, focus change, OR terminal output — the overlay
 * resets `lastActivityMs` on all of them (the "no input AND no output" rule).
 */
export function isIdle(lastActivityMs: number, nowMs: number, timeoutSec: number): boolean {
  return nowMs - lastActivityMs >= timeoutSec * 1000;
}

/** Milliseconds until idle should fire (never negative) — schedules one timer. */
export function msUntilIdle(lastActivityMs: number, nowMs: number, timeoutSec: number): number {
  return Math.max(0, lastActivityMs + timeoutSec * 1000 - nowMs);
}
