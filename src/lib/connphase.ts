// Pure logic for the connecting overlay's phase checklist (ADR 0003). The SSH
// backend emits real phase events on `term://phase/{id}`: an optional "proxy"
// stage (only when a jump host is configured), then "connecting" →
// "authenticating" → "session". This maps the current phase to per-step states
// so the overlay component stays presentational and the mapping is unit-tested.

/** Connection phase reported by the backend (see ssh.rs `phase_event`). The
 *  "proxy" phase is emitted only for servers that connect through a jump host. */
export type ConnPhase = "proxy" | "connecting" | "authenticating" | "session";

/** Visual state of a single step in the checklist. */
export type StepState = "done" | "active" | "pending" | "error";

export interface PhaseStep {
  phase: ConnPhase;
  state: StepState;
}

/** Ordered phases for a direct connection, matching the sequential stages in
 *  ssh.rs `connect`. A proxied connection prepends the `proxy` phase (see
 *  `phaseSteps`), so no-proxy servers keep exactly these three steps. */
export const PHASE_ORDER: ConnPhase[] = ["connecting", "authenticating", "session"];

/**
 * Map the current phase to the state of every step. Steps before the current
 * one are `done`, the current one is `active` (or `error` when the connection
 * failed on it), and later ones are `pending`. An unknown phase falls back to
 * the first step being active.
 *
 * When `hasProxy` is true the `proxy` step is prepended (variant A: the step is
 * shown only for servers that actually use a jump host); otherwise the checklist
 * is unchanged from a direct connection.
 */
export function phaseSteps(
  current: ConnPhase,
  errored = false,
  hasProxy = false,
): PhaseStep[] {
  const order: ConnPhase[] = hasProxy ? ["proxy", ...PHASE_ORDER] : PHASE_ORDER;
  const idx = Math.max(0, order.indexOf(current));
  return order.map((phase, i) => ({
    phase,
    state:
      i < idx ? "done" : i === idx ? (errored ? "error" : "active") : "pending",
  }));
}
