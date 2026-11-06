import { describe, expect, it } from "vitest";
import { loadCoreLevel, loadHealth, loadZones, sensorLevel, worstLevel } from "./monhealth";
import { thresholdLevel } from "./thresholds";
import type { StatusBarThresholds } from "../settings/settings.svelte";
import type { Sensor } from "../api";

const th: StatusBarThresholds = {
  cpu: { warn: 80, crit: 95 },
  ram: { warn: 85, crit: 95 },
  swap: { warn: 50, crit: 90 },
  disk: { warn: 85, crit: 95 },
  load: { warn: null, crit: null },
  cpuTemp: { warn: 75, crit: 90 },
  fd: { warn: 80, crit: 95 },
  inodes: { warn: 85, crit: 95 },
};


describe("worstLevel", () => {
  it("picks the most severe level", () => {
    expect(worstLevel(["ok", "warn", "ok"])).toBe("warn");
    expect(worstLevel(["ok", "crit", "warn"])).toBe("crit");
    expect(worstLevel([])).toBe("ok");
  });
});

describe("loadCoreLevel", () => {
  it("maps per-core load to a level", () => {
    expect(loadCoreLevel(1.2)).toBe("crit");
    expect(loadCoreLevel(0.8)).toBe("warn");
    expect(loadCoreLevel(0.3)).toBe("ok");
    expect(loadCoreLevel(null)).toBe("ok");
  });
});

describe("sensorLevel", () => {
  const s = (temp: number, high: number | null, crit: number | null): Sensor =>
    ({ label: "x", temp, high, crit }) as Sensor;
  it("uses own crit/high first, else cpuTemp threshold", () => {
    expect(sensorLevel(s(101, 84, 100), th.cpuTemp)).toBe("crit");
    expect(sensorLevel(s(90, 84, 100), th.cpuTemp)).toBe("warn");
    expect(sensorLevel(s(50, 84, 100), th.cpuTemp)).toBe("ok");
    // No own limits → fall back to cpuTemp thresholds (76 ≥ warn 75).
    expect(sensorLevel(s(76, null, null), th.cpuTemp)).toBe("warn");
  });
});

describe("load health", () => {
  it("load takes the worst of load1 threshold and per-core", () => {
    expect(loadHealth(0.1, 1.1, th.load)).toBe("crit"); // per-core overload
    expect(loadHealth(0.1, 0.8, th.load)).toBe("warn");
    expect(loadHealth(90, 0.1, { warn: 50, crit: null })).toBe("warn"); // load1 threshold
    expect(loadHealth(0.1, 0.1, th.load)).toBe("ok");
  });

});

describe("loadZones", () => {
  it("puts the bounds at 0.7 and 1 per thread, as decimals", () => {
    expect(loadZones(1, th.load)).toEqual({ warn: 0.7, crit: 1 });
    // 0.7 × 3 is 2.0999…96 in floating point: the bound is the 2.1 it means.
    expect(loadZones(3, th.load)).toEqual({ warn: 2.1, crit: 3 });
    expect(loadZones(16, th.load)).toEqual({ warn: 11.2, crit: 16 });
  });

  it("takes the user's load threshold where it is lower, and nothing without either", () => {
    expect(loadZones(16, { warn: 4, crit: 8 })).toEqual({ warn: 4, crit: 8 });
    expect(loadZones(2, { warn: 4, crit: null })).toEqual({ warn: 1.4, crit: 2 });
    expect(loadZones(0, { warn: 4, crit: null })).toEqual({ warn: 4, crit: null });
    expect(loadZones(0, th.load)).toEqual({ warn: null, crit: null });
  });

  it("is the rule `loadHealth` judges by — the chart and the list cannot disagree", () => {
    const ths = [th.load, { warn: 1.5, crit: 6 }, { warn: null, crit: 2.5 }, { warn: 9, crit: null }];
    for (const threads of [1, 2, 3, 6, 7, 12, 64]) {
      for (const lt of ths) {
        for (let i = 0; i <= 1200; i++) {
          const load1 = i / 100;
          expect(thresholdLevel(load1, loadZones(threads, lt)), `${load1} on ${threads}`).toBe(
            loadHealth(load1, load1 / threads, lt),
          );
        }
      }
    }
  });
});
