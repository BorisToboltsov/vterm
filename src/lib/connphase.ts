// Pure logic for the connecting overlay's phase checklist (ADR 0003). The SSH
// backend emits real phase events on `term://phase/{id}`. A direct connection
// goes "connecting" → "authenticating" → "session". A proxied connection emits
// its own sub-phases first, grouped under the proxy: a jump host mirrors a full
// SSH connect (connect → auth → tunnel), while SOCKS5/HTTP have a TCP connect +
// a handshake. This maps the current phase to per-step states (and their group)
// so the overlay stays presentational and the mapping is unit-tested.

/** Connection phase reported by the backend (see ssh.rs `phase_event`). The
 *  `proxy*` phases are emitted only for servers that connect through a proxy. */
export type ConnPhase =
  | "proxyConnecting"
  | "proxyAuthenticating"
  | "proxyTunnel"
  | "proxyHandshake"
  | "connecting"
  | "authenticating"
  | "session";

/** Shape of a configured proxy, deciding its sub-phase set: `jump` (SSH bastion:
 *  connect → auth → tunnel) or `tcp` (SOCKS5/HTTP: connect → handshake). */
export type ProxyShape = "jump" | "tcp";

/** Visual state of a single step in the checklist. */
export type StepState = "done" | "active" | "pending" | "error";

/** Which group a step belongs to in the grouped (proxied) checklist. */
export type StepGroup = "proxy" | "server";

export interface PhaseStep {
  phase: ConnPhase;
  state: StepState;
  group: StepGroup;
}

/** Ordered target phases, matching the sequential stages in ssh.rs `connect`. A
 *  proxied connection prepends the proxy's sub-phases (see `phaseSteps`), so
 *  no-proxy servers keep exactly these three steps. */
export const PHASE_ORDER: ConnPhase[] = ["connecting", "authenticating", "session"];

/** Proxy sub-phases per shape, in emission order. */
const PROXY_STEPS: Record<ProxyShape, ConnPhase[]> = {
  jump: ["proxyConnecting", "proxyAuthenticating", "proxyTunnel"],
  tcp: ["proxyConnecting", "proxyHandshake"],
};

/**
 * Map the current phase to the state of every step. Steps before the current
 * one are `done`, the current one is `active` (or `error` when the connection
 * failed on it), and later ones are `pending`. An unknown phase falls back to
 * the first step being active.
 *
 * When `proxy` is set, that shape's sub-phases are prepended and tagged with the
 * `proxy` group (the overlay renders them under a proxy header — variant B); the
 * target steps carry the `server` group. `null` → a plain direct connection.
 */
export function phaseSteps(
  current: ConnPhase,
  errored = false,
  proxy: ProxyShape | null = null,
): PhaseStep[] {
  const proxySteps = proxy ? PROXY_STEPS[proxy] : [];
  const order: ConnPhase[] = [...proxySteps, ...PHASE_ORDER];
  const idx = Math.max(0, order.indexOf(current));
  return order.map((phase, i) => ({
    phase,
    state:
      i < idx ? "done" : i === idx ? (errored ? "error" : "active") : "pending",
    group: i < proxySteps.length ? "proxy" : "server",
  }));
}
