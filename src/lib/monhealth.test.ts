import { describe, expect, it } from "vitest";
import {
  cpuHealth,
  extrasHealth,
  fsHealth,
  hasTempData,
  loadCoreLevel,
  loadHealth,
  memHealth,
  netHealth,
  sensorLevel,
  tempHealth,
  worstLevel,
} from "./monhealth";
import type { StatusBarThresholds } from "./settings.svelte";
import type { Extras, Metrics, MetricsDetail, Sensor } from "./api";

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

const m = (o: Partial<Metrics>) => o as Metrics;
const d = (o: Partial<MetricsDetail>) => o as MetricsDetail;

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

describe("block health from settings thresholds", () => {
  it("cpu/mem use the configured thresholds", () => {
    expect(cpuHealth(m({ cpuPct: 96 }), th)).toBe("crit");
    expect(cpuHealth(m({ cpuPct: 82 }), th)).toBe("warn");
    expect(cpuHealth(m({ cpuPct: 20 }), th)).toBe("ok");
    // Memory takes the worst of RAM and swap.
    expect(memHealth(m({ memUsed: 96, memTotal: 100, swapUsed: 0, swapTotal: 0 }), th)).toBe("crit");
    expect(memHealth(m({ memUsed: 1, memTotal: 10, swapUsed: 6, swapTotal: 10 }), th)).toBe("warn");
  });

  it("fs takes the worst of partition usage, inodes and FD; ∞ FD ignored", () => {
    expect(
      fsHealth(d({ partitions: [{ mount: "/", fstype: "ext4", used: 96, total: 100, inodesUsed: null, inodesTotal: null }] }), th),
    ).toBe("crit");
    expect(
      fsHealth(d({ partitions: [{ mount: "/", fstype: "ext4", used: 10, total: 100, inodesUsed: 90, inodesTotal: 100 }] }), th),
    ).toBe("warn");
    // Unlimited file-max must not register as a breach.
    expect(fsHealth(d({ partitions: [], fileNrUsed: 1000, fileNrMax: 9223372036854775807 }), th)).toBe("ok");
  });

  it("load takes the worst of load1 threshold and per-core", () => {
    expect(loadHealth(0.1, 1.1, th.load)).toBe("crit"); // per-core overload
    expect(loadHealth(0.1, 0.8, th.load)).toBe("warn");
    expect(loadHealth(90, 0.1, { warn: 50, crit: null })).toBe("warn"); // load1 threshold
    expect(loadHealth(0.1, 0.1, th.load)).toBe("ok");
  });

  it("network warns on errors/drops", () => {
    expect(netHealth(d({ netIfaces: [{ name: "eth0", rxRate: 0, txRate: 0, rxErrs: 0, rxDrop: 0, txErrs: 0, txDrop: 0 }] }))).toBe("ok");
    expect(netHealth(d({ netIfaces: [{ name: "eth0", rxRate: 0, txRate: 0, rxErrs: 3, rxDrop: 0, txErrs: 0, txDrop: 0 }] }))).toBe("warn");
  });

  it("temperature uses sensors, else cpuTemp", () => {
    expect(tempHealth(d({ sensors: [{ label: "x", temp: 95, high: 84, crit: 100 }] }), m({}), th)).toBe("warn");
    expect(tempHealth(d({ sensors: [] }), m({ cpuTemp: 92 }), th)).toBe("crit");
    expect(hasTempData(d({ sensors: [] }), m({ cpuTemp: null }))).toBe(false);
    expect(hasTempData(d({ sensors: [] }), m({ cpuTemp: 40 }))).toBe(true);
  });

  it("extras: SMART failure is crit, OOM is warn", () => {
    expect(extrasHealth({ gpus: [], docker: [], smart: [{ device: "sda", health: "FAILED", temp: null, powerOnHours: null }], oomKills: 0 } as Extras)).toBe("crit");
    expect(extrasHealth({ gpus: [], docker: [], smart: [], oomKills: 2 } as Extras)).toBe("warn");
    expect(extrasHealth({ gpus: [], docker: [], smart: [{ device: "sda", health: "PASSED", temp: null, powerOnHours: null }], oomKills: 0 } as Extras)).toBe("ok");
    expect(extrasHealth(null)).toBe("ok");
  });
});
