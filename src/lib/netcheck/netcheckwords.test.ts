import { describe, expect, it } from "vitest";
import { methodLabel, reportWords, STATUS_KEY } from "./netcheckwords";

describe("netcheckwords", () => {
  it("names the probe methods: tools as themselves, the native one in words", () => {
    expect(methodLabel("bash")).toBe("bash /dev/tcp");
    expect(methodLabel("nc")).toBe("nc");
    expect(methodLabel("none")).toBe("—");
    expect(methodLabel("native")).toBe("TCP connect from this machine");
  });

  it("gives the report every status and the method of its own server", () => {
    const w = reportWords("nc", 5);
    expect(w.method).toBe("Method: nc · timeout 5 s");
    expect(reportWords(null, 3).method).toBe("Method: — · timeout 3 s");
    expect(Object.keys(w.status).sort()).toEqual(Object.keys(STATUS_KEY).sort());
    expect(w.tally(1, 2)).toBe("1 of 2 open");
    expect(w.rest(3, "timeout 3")).toBe("3 others: timeout 3");
    expect(w.ms(4)).toBe("4 ms");
    expect(w.ruleSource("10.0.0.1")).toBe("rule says 10.0.0.1");
  });
});
