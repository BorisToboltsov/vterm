import type { ConnPhase } from "./connphase";
import type { MessageKey } from "./i18n";

/** Action offered on the SSH failure overlay: reconnect from scratch, or reopen
 *  the secret prompt to re-authenticate. */
export type SshErrorAction = "reconnect" | "reauth";

/** Content for the SSH connecting-overlay's failure state. `titleKey`/`detailKey`
 *  are i18n keys the caller resolves with `t()`; `detailText` is already-plain
 *  error text (the raw backend message) shown as-is. */
export type SshErrorView = {
  titleKey: MessageKey;
  detailKey?: MessageKey;
  detailText?: string;
  phase: ConnPhase;
  showSteps: boolean;
  action: SshErrorAction;
};

/**
 * Map an SSH tab's status string to the failure overlay's content. Pure so the
 * status→view branching (dropped / auth-rejected / host-key-rejected / generic)
 * is unit-tested without DOM or i18n. `currentPhase` is the session's last connect
 * phase (the caller applies its own default, e.g. `connPhase[id] ?? "connecting"`);
 * the auth-failure case pins the phase to `authenticating` regardless.
 */
export function sshErrorView(status: string, currentPhase: ConnPhase): SshErrorView {
  if (status.startsWith("Disconnected")) {
    // Dropped after a successful connect — not a phase failure.
    return {
      titleKey: "connecting.lost",
      phase: "session",
      showSteps: false,
      action: "reconnect",
    };
  }
  const raw = status.replace(/^Error:\s*/, "");
  // Proxy markers are checked before the generic `auth-rejected` since the proxy
  // marker (`proxy-auth-rejected`) also contains that substring.
  if (raw.includes("proxy-auth-rejected")) {
    return {
      titleKey: "connecting.proxyAuthFailed",
      detailKey: "connecting.proxyAuthDetail",
      // Freeze on the jump host's own authentication sub-step.
      phase: "proxyAuthenticating",
      showSteps: true,
      action: "reconnect",
    };
  }
  if (raw.includes("auth-rejected")) {
    return {
      titleKey: "connecting.authFailed",
      detailKey: "connecting.authFailedDetail",
      phase: "authenticating",
      showSteps: true,
      action: "reauth",
    };
  }
  if (raw.includes("host-key-rejected")) {
    return {
      titleKey: "connecting.hostKeyFailed",
      detailKey: "connecting.hostKeyDetail",
      phase: currentPhase,
      showSteps: true,
      action: "reconnect",
    };
  }
  return {
    titleKey: "connecting.connectFailed",
    detailText: raw,
    phase: currentPhase,
    showSteps: true,
    action: "reconnect",
  };
}
