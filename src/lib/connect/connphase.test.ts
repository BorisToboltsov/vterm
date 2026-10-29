import { describe, it, expect } from "vitest";
import { phaseSteps, PHASE_ORDER, type ConnPhase } from "./connphase";

describe("phaseSteps", () => {
  it("marks the first phase active with the rest pending", () => {
    expect(phaseSteps("connecting")).toEqual([
      { phase: "connecting", state: "active", group: "server" },
      { phase: "authenticating", state: "pending", group: "server" },
      { phase: "session", state: "pending", group: "server" },
    ]);
  });

  it("marks earlier phases done and later ones pending", () => {
    expect(phaseSteps("authenticating").map((s) => s.state)).toEqual([
      "done",
      "active",
      "pending",
    ]);
  });

  it("marks all but the last done on the final phase", () => {
    expect(phaseSteps("session").map((s) => s.state)).toEqual(["done", "done", "active"]);
  });

  it("renders the active phase as error when the connection failed", () => {
    expect(phaseSteps("authenticating", true).map((s) => s.state)).toEqual([
      "done",
      "error",
      "pending",
    ]);
  });

  it("falls back to the first step for an unknown phase", () => {
    expect(phaseSteps("bogus" as ConnPhase)[0].state).toBe("active");
  });

  it("keeps the phase order aligned with the backend stages", () => {
    expect(PHASE_ORDER).toEqual(["connecting", "authenticating", "session"]);
  });

  it("has no proxy group by default (direct connection)", () => {
    expect(phaseSteps("connecting").map((s) => s.phase)).toEqual([
      "connecting",
      "authenticating",
      "session",
    ]);
    expect(phaseSteps("connecting").every((s) => s.group === "server")).toBe(true);
  });

  it("prepends the jump host's three sub-phases under the proxy group", () => {
    const steps = phaseSteps("proxyConnecting", false, "jump");
    expect(steps.map((s) => s.phase)).toEqual([
      "proxyConnecting",
      "proxyAuthenticating",
      "proxyTunnel",
      "connecting",
      "authenticating",
      "session",
    ]);
    expect(steps.map((s) => s.group)).toEqual([
      "proxy",
      "proxy",
      "proxy",
      "server",
      "server",
      "server",
    ]);
    expect(steps[0].state).toBe("active");
  });

  it("gives a tcp proxy (SOCKS5/HTTP) two sub-phases: connect + handshake", () => {
    const steps = phaseSteps("proxyHandshake", false, "tcp");
    expect(steps.filter((s) => s.group === "proxy").map((s) => s.phase)).toEqual([
      "proxyConnecting",
      "proxyHandshake",
    ]);
    // Past the connect sub-phase → done, handshake active, target pending.
    expect(steps.map((s) => s.state)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("marks all proxy sub-phases done once on a target phase", () => {
    const steps = phaseSteps("connecting", false, "jump");
    expect(steps.slice(0, 3).every((s) => s.state === "done")).toBe(true);
    expect(steps[3].state).toBe("active");
  });

  it("freezes the failing proxy sub-phase as error", () => {
    expect(phaseSteps("proxyAuthenticating", true, "jump").map((s) => s.state)).toEqual([
      "done",
      "error",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });
});
