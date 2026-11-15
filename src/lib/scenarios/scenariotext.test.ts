import { describe, expect, it } from "vitest";
import { cellLook, changeLook, hostLook } from "./scenariotext";

describe("how the Scenarios say things", () => {
  it("gives every state, cell and change a look", () => {
    for (const s of ["waiting", "connecting", "checking", "running", "same", "change", "ok", "skipped", "failed", "stopped", "bogus"]) {
      expect(hostLook(s).text).not.toBe("");
    }
    expect(cellLook("changed", true, false).text).toBe("would change");
    expect(cellLook("changed", false, false).text).toBe("changed");
    expect(cellLook("failed", false, true).text).toBe("ignored");
    for (const s of ["running", "ok", "failed", "skipped", "unreachable"] as const) expect(cellLook(s, false, false).cls).not.toBe("");
    expect(changeLook("delete").sign).toBe("−");
    for (const k of ["create", "update", "replace", "read", "noop"] as const) expect(changeLook(k).sign).toBeTruthy();
  });
});
