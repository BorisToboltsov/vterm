// Pure logic for the connecting overlay's phase checklist (ADR 0003). The SSH
// backend emits real phase events on `term://phase/{id}` ("connecting" →
// "authenticating" → "session"); this maps the current phase to per-step states
// so the overlay component stays presentational and the mapping is unit-tested.

/** Connection phase reported by the backend (see ssh.rs `phase_event`). */
export type ConnPhase = "connecting" | "authenticating" | "session";

/** Visual state of a single step in the checklist. */
export type StepState = "done" | "active" | "pending" | "error";

export interface PhaseStep {
  phase: ConnPhase;
  state: StepState;
}

/** Ordered phases, matching the sequential stages in ssh.rs `connect`. */
export const PHASE_ORDER: ConnPhase[] = ["connecting", "authenticating", "session"];

/**
 * Map the current phase to the state of every step. Steps before the current
 * one are `done`, the current one is `active` (or `error` when the connection
 * failed on it), and later ones are `pending`. An unknown phase falls back to
 * the first step being active.
 */
export function phaseSteps(current: ConnPhase, errored = false): PhaseStep[] {
  const idx = Math.max(0, PHASE_ORDER.indexOf(current));
  return PHASE_ORDER.map((phase, i) => ({
    phase,
    state:
      i < idx ? "done" : i === idx ? (errored ? "error" : "active") : "pending",
  }));
}
