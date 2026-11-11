import { describe, expect, it } from "vitest";
import {
  FRESH,
  onConnected,
  onDropped,
  onFailed,
  RECONNECT_DELAYS_MS,
  retryable,
  STABLE_MS,
  type ReconnectState,
} from "./reconnect";

const T = 1_000_000;

describe("reconnecting a dropped session", () => {
  it("a session that stood is tried again after the first pause", () => {
    const up = onConnected(FRESH, T);
    const { state, step } = onDropped(up, T + STABLE_MS + 1);
    expect(step).toEqual({ kind: "wait", delay: RECONNECT_DELAYS_MS[0], attempt: 1, of: RECONNECT_DELAYS_MS.length });
    expect(state).toEqual({ attempt: 1, connectedAt: null });
  });

  it("attempts that fail wait longer each time, and the last one gives up", () => {
    let state: ReconnectState = onDropped(onConnected(FRESH, T), T + STABLE_MS).state;
    const delays: number[] = [RECONNECT_DELAYS_MS[0]];
    for (;;) {
      const r = onFailed(state, "connection refused");
      if (r.step.kind !== "wait") {
        expect(r.step).toEqual({ kind: "giveUp", attempts: RECONNECT_DELAYS_MS.length });
        expect(r.state).toEqual(FRESH);
        break;
      }
      delays.push(r.step.delay);
      state = r.state;
    }
    expect(delays).toEqual([...RECONNECT_DELAYS_MS]);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });

  it("a server that lets in and throws out at once is not dialled forever", () => {
    let state = FRESH;
    let t = T;
    let steps = 0;
    for (;;) {
      state = onConnected(state, t);
      t += 2000; // dropped two seconds after each login
      const r = onDropped(state, t);
      state = r.state;
      if (r.step.kind === "giveUp") break;
      steps++;
      expect(steps).toBeLessThanOrEqual(RECONNECT_DELAYS_MS.length);
    }
    expect(steps).toBe(RECONNECT_DELAYS_MS.length);
  });

  it("standing long enough after a reconnect starts the count afresh", () => {
    let state = onDropped(onConnected(FRESH, T), T + STABLE_MS).state;
    state = onFailed(state, "timed out").state;
    expect(state.attempt).toBe(2);
    const up = onConnected(state, T + 100_000);
    expect(onDropped(up, T + 100_000 + STABLE_MS).state.attempt).toBe(1);
    expect(onDropped(up, T + 100_000 + 1000).state.attempt).toBe(3);
  });

  it("a connect the user started is the user's: its failure is not retried", () => {
    expect(onFailed(FRESH, "connection refused")).toEqual({ state: FRESH, step: { kind: "none" } });
  });

  it("an error no attempt mends stops at once", () => {
    const trying = { attempt: 2, connectedAt: null };
    for (const e of [
      "auth-rejected: wrong password or key not accepted",
      "host-key-rejected: server key not trusted",
      "auth-unsupported: the server does not accept this login method (it offers: publickey)",
      "auth-cancelled: login cancelled",
      "proxy-auth-rejected: jump host rejected the credentials",
      "unknown server",
      "password required",
    ]) {
      expect(retryable(e), e).toBe(false);
      expect(onFailed(trying, e).step, e).toEqual({ kind: "giveUp", attempts: 2 });
    }
    for (const e of ["Connection refused (os error 61)", "exec channel failed: the server did not answer in 10 s", "timed out"]) {
      expect(retryable(e), e).toBe(true);
    }
  });
});
