import { describe, it, expect } from "vitest";
import { phaseSteps, PHASE_ORDER, type ConnPhase } from "./connphase";

describe("phaseSteps", () => {
  it("marks the first phase active with the rest pending", () => {
    expect(phaseSteps("connecting")).toEqual([
      { phase: "connecting", state: "active" },
      { phase: "authenticating", state: "pending" },
      { phase: "session", state: "pending" },
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

  it("omits the proxy step by default (variant A: direct connection)", () => {
    expect(phaseSteps("connecting").map((s) => s.phase)).toEqual([
      "connecting",
      "authenticating",
      "session",
    ]);
  });

  it("prepends the proxy step when hasProxy is set", () => {
    expect(phaseSteps("proxy", false, true)).toEqual([
      { phase: "proxy", state: "active" },
      { phase: "connecting", state: "pending" },
      { phase: "authenticating", state: "pending" },
      { phase: "session", state: "pending" },
    ]);
  });

  it("marks the proxy step done once past it", () => {
    expect(phaseSteps("connecting", false, true).map((s) => s.state)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });

  it("renders the proxy step as error when the jump host failed", () => {
    expect(phaseSteps("proxy", true, true).map((s) => s.state)).toEqual([
      "error",
      "pending",
      "pending",
      "pending",
    ]);
  });
});
