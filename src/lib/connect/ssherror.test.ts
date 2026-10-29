import { describe, it, expect } from "vitest";
import { sshErrorView } from "./ssherror";

describe("sshErrorView", () => {
  it("maps a dropped connection to the 'lost' view (no steps, reconnect)", () => {
    const v = sshErrorView("Disconnected", "session");
    expect(v).toEqual({
      titleKey: "connecting.lost",
      phase: "session",
      showSteps: false,
      action: "reconnect",
    });
  });

  it("maps auth-rejected to the auth-failure view, pinned to authenticating", () => {
    // Phase is pinned regardless of the passed currentPhase.
    const v = sshErrorView("Error: auth-rejected", "connecting");
    expect(v.titleKey).toBe("connecting.authFailed");
    expect(v.detailKey).toBe("connecting.authFailedDetail");
    expect(v.detailText).toBeUndefined();
    expect(v.phase).toBe("authenticating");
    expect(v.showSteps).toBe(true);
    expect(v.action).toBe("reauth");
  });

  it("maps host-key-rejected to the host-key view, keeping the current phase", () => {
    const v = sshErrorView("Error: host-key-rejected", "connecting");
    expect(v.titleKey).toBe("connecting.hostKeyFailed");
    expect(v.detailKey).toBe("connecting.hostKeyDetail");
    expect(v.phase).toBe("connecting");
    expect(v.action).toBe("reconnect");
  });

  it("maps a generic error to raw detail text, keeping the current phase", () => {
    const v = sshErrorView("Error: connection refused", "authenticating");
    expect(v.titleKey).toBe("connecting.connectFailed");
    expect(v.detailKey).toBeUndefined();
    // The "Error:" prefix is stripped; the rest is shown as plain text.
    expect(v.detailText).toBe("connection refused");
    expect(v.phase).toBe("authenticating");
    expect(v.showSteps).toBe(true);
    expect(v.action).toBe("reconnect");
  });

  it("treats an error without the 'Error:' prefix as generic detail text", () => {
    const v = sshErrorView("something went wrong", "connecting");
    expect(v.titleKey).toBe("connecting.connectFailed");
    expect(v.detailText).toBe("something went wrong");
  });

  it("maps proxy-auth-rejected to the proxy-auth view, pinned to the jump auth sub-step", () => {
    // Checked before the generic auth-rejected (whose text it also contains).
    const v = sshErrorView("Error: proxy-auth-rejected", "connecting");
    expect(v.titleKey).toBe("connecting.proxyAuthFailed");
    expect(v.detailKey).toBe("connecting.proxyAuthDetail");
    expect(v.phase).toBe("proxyAuthenticating");
    expect(v.showSteps).toBe(true);
    expect(v.action).toBe("reconnect");
  });

  // v1.0.38: the server offering no method this profile can use is not "wrong
  // password" — the password may be right (UniFi before keyboard-interactive).
  it("maps auth-unsupported to its own view with the methods the server offers", () => {
    const v = sshErrorView(
      "Error: auth-unsupported: the server does not accept this login method (it offers: publickey)",
      "connecting",
    );
    expect(v.titleKey).toBe("connecting.authUnsupported");
    expect(v.detailKey).toBe("connecting.authUnsupportedDetail");
    expect(v.detailVars).toEqual({ methods: "publickey" });
    expect(v.phase).toBe("authenticating");
    // Retyping the password can't help — reconnect after fixing the profile.
    expect(v.action).toBe("reconnect");
  });

  it("maps the jump host's unsupported method to the proxy variant", () => {
    const v = sshErrorView(
      "Error: proxy-auth-unsupported: the jump host does not accept this login method (it offers: publickey, gssapi-with-mic)",
      "connecting",
    );
    expect(v.titleKey).toBe("connecting.proxyAuthUnsupported");
    expect(v.detailVars).toEqual({ methods: "publickey, gssapi-with-mic" });
    expect(v.phase).toBe("proxyAuthenticating");
  });

  it("maps a cancelled login to a plain reconnect, not a failure to retype", () => {
    const v = sshErrorView("Error: auth-cancelled: login cancelled", "authenticating");
    expect(v.titleKey).toBe("connecting.authCancelled");
    expect(v.action).toBe("reconnect");
  });
});
