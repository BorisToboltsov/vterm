// Reconnecting a dropped SSH session by itself (setting `autoReconnect`, ADR
// 0062), as the page drives it: the attempts of each tab, the pause before the
// next one, and what the diagnostics are told (ADR 0063) — not the user: the
// tab's own screen says where it stands. When to try and when to stop is `connect/reconnect.ts`;
// opening the session is the page's (`reconnectTab`).
//
// A connect this flow did not start (the tab's button, a new tab) is the user's:
// it clears the count and any attempt that was waiting.
import { diag } from "../api/diag";
import { aboutSession } from "../stores/diag.svelte";
import {
  FRESH,
  onConnected,
  onDropped,
  onFailed,
  type ReconnectState,
  type ReconnectStep,
} from "../connect/reconnect";

/** A tab's status as its terminal reports it. */
export type SessionStatus = "connecting" | "connected" | "closed" | "error";

/** What the page tells the flow, each read when it is needed. */
export interface ReconnectDeps {
  /** Dropped sessions reconnect by themselves (`settings.autoReconnect`). */
  auto: () => boolean;
  /** The tab is still there. */
  exists: (sessionId: string) => boolean;
  /** Open the tab's session again. */
  reconnect: (sessionId: string) => void;
  now?: () => number;
}

export function createReconnectFlow(deps: ReconnectDeps) {
  const now = deps.now ?? Date.now;
  const states = new Map<string, ReconnectState>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tabs whose next "connecting" is this flow's own attempt. */
  const ours = new Set<string>();

  function cancel(sessionId: string) {
    const timer = timers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(sessionId);
  }

  function apply(sessionId: string, step: ReconnectStep, detail: string) {
    const about = aboutSession(sessionId);
    if (step.kind === "wait") {
      diag.info(
        "connection",
        `reconnect attempt ${step.attempt} of ${step.of} in ${Math.round(step.delay / 1000)} s`,
        { attempt: step.attempt, of: step.of, delayMs: step.delay },
        { ...about, code: "reconnect-wait" },
      );
      cancel(sessionId);
      timers.set(
        sessionId,
        setTimeout(() => {
          timers.delete(sessionId);
          if (!deps.exists(sessionId)) return forget(sessionId);
          ours.add(sessionId);
          deps.reconnect(sessionId);
        }, step.delay),
      );
    } else if (step.kind === "giveUp") {
      diag.warn("connection", `reconnect gave up after ${step.attempts} attempts: ${detail}`, { attempts: step.attempts }, { ...about, code: "reconnect-gave-up" });
    }
  }

  function forget(sessionId: string) {
    cancel(sessionId);
    states.delete(sessionId);
    ours.delete(sessionId);
  }

  return {
    /** What a tab's terminal reported; `detail` — the error, when there is one. */
    status(sessionId: string, status: SessionStatus, detail = "") {
      const state = states.get(sessionId) ?? FRESH;
      switch (status) {
        case "connecting":
          // Our own attempt goes on with the count; anyone else's starts afresh.
          if (ours.delete(sessionId)) return;
          cancel(sessionId);
          states.delete(sessionId);
          return;
        case "connected":
          if (state.attempt > 0) {
            diag.info("connection", `reconnected after ${state.attempt} attempts`, { attempts: state.attempt }, { ...aboutSession(sessionId), code: "reconnected" });
          }
          states.set(sessionId, onConnected(state, now()));
          return;
        case "closed": {
          if (!deps.auto()) {
            diag.info("connection", "session closed", undefined, { ...aboutSession(sessionId), code: "session-closed" });
            states.delete(sessionId);
            return;
          }
          const { state: next, step } = onDropped(state, now());
          states.set(sessionId, next);
          apply(sessionId, step, detail || "session closed");
          return;
        }
        case "error": {
          if (!deps.auto()) return void states.delete(sessionId);
          const { state: next, step } = onFailed(state, detail);
          states.set(sessionId, next);
          apply(sessionId, step, detail);
          return;
        }
      }
    },
    /** The tab is closed: its count and any waiting attempt go. */
    forget,
    /** An attempt of this tab is waiting for its pause to end. */
    waiting: (sessionId: string): boolean => timers.has(sessionId),
  };
}
