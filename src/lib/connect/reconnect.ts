// When a dropped SSH session is reconnected by itself (setting `autoReconnect`,
// ADR 0062): after a pause that grows with each attempt, a limited number of
// times, and never for an error no attempt can mend.
//
// The page used to reconnect one second after every drop, with no count: a
// server that accepted the login and closed at once (rebooting, a shell that
// exits, a `ForceCommand`) was dialled every couple of seconds for as long as the
// tab stood, and a reconnect that failed was simply the end of it. Pure: the
// times come in, the page's flow (`page/reconnectflow`) keeps the state per tab.

/** The pause before each attempt, ms; how many there are is how many attempts. */
export const RECONNECT_DELAYS_MS = [1000, 3000, 5000, 10_000, 20_000, 30_000] as const;

/** Connected this long, a session is up again: the next drop starts the count afresh. */
export const STABLE_MS = 30_000;

/** A tab's reconnecting: the attempts made since it last stood, and since when it is connected. */
export interface ReconnectState {
  attempt: number;
  connectedAt: number | null;
}

export const FRESH: ReconnectState = { attempt: 0, connectedAt: null };

export type ReconnectStep =
  | { kind: "none" }
  /** Try again after `delay`: attempt `attempt` of `of`. */
  | { kind: "wait"; delay: number; attempt: number; of: number }
  /** Stop trying: `attempts` were made, or the error is one no attempt mends. */
  | { kind: "giveUp"; attempts: number };

/**
 * Errors another attempt cannot mend: the server refused the login or its key,
 * the login was cancelled, the profile is gone or lacks what it needs. Their
 * markers are the backend's (`AppError`'s `Display`).
 */
export function retryable(detail: string): boolean {
  return !/auth-rejected|host-key-rejected|auth-unsupported|auth-cancelled|proxy-auth-rejected|unknown server|password required|no SSH key|no proxy SSH key/i.test(
    detail,
  );
}

function next(attempt: number): ReconnectStep {
  const of = RECONNECT_DELAYS_MS.length;
  if (attempt >= of) return { kind: "giveUp", attempts: attempt };
  return { kind: "wait", delay: RECONNECT_DELAYS_MS[attempt], attempt: attempt + 1, of };
}

/** The session connected at `now`. */
export function onConnected(state: ReconnectState, now: number): ReconnectState {
  return { ...state, connectedAt: now };
}

/**
 * The session dropped at `now`. One that stood `STABLE_MS` starts the count
 * afresh; one that dropped soon after connecting goes on with it — a server
 * that lets in and throws out is not dialled forever.
 */
export function onDropped(state: ReconnectState, now: number): { state: ReconnectState; step: ReconnectStep } {
  const stood = state.connectedAt !== null && now - state.connectedAt >= STABLE_MS;
  const step = next(stood ? 0 : state.attempt);
  return { state: step.kind === "wait" ? { attempt: step.attempt, connectedAt: null } : FRESH, step };
}

/**
 * A connect failed with `detail`. Only one of ours is answered: a tab the user
 * opened (or reconnected by hand) that failed is the user's to retry.
 */
export function onFailed(state: ReconnectState, detail: string): { state: ReconnectState; step: ReconnectStep } {
  if (state.attempt === 0) return { state, step: { kind: "none" } };
  if (!retryable(detail)) return { state: FRESH, step: { kind: "giveUp", attempts: state.attempt } };
  const step = next(state.attempt);
  return { state: step.kind === "wait" ? { attempt: step.attempt, connectedAt: null } : FRESH, step };
}
