import { describe, expect, it } from "vitest";
import type { Extras, Metrics, MetricsDetail, PendingUpdates } from "../api";
import type { StatusBarThresholds } from "../settings/settings.svelte";
import { baselineOf, problems, sectionLevels, type ProblemInput } from "./monproblems";

// The shipped defaults (settings.svelte.ts).
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

const metrics = (o: Partial<Metrics> = {}): Metrics =>
  ({ cpuPct: 20, memUsed: 4, memTotal: 16, swapUsed: 0, swapTotal: 0, load1: 1, cpuCount: 8, cpuTemp: null, ...o }) as Metrics;

const detail = (o: Partial<MetricsDetail> = {}): MetricsDetail =>
  ({
    perCpu: Array(8).fill(10),
    partitions: [],
    fileNrUsed: null,
    fileNrMax: null,
    netIfaces: [],
    sensors: [],
    failedUnits: 0,
    failedUnitNames: [],
    timeSynced: true,
    throttleCount: null,
    ...o,
  }) as MetricsDetail;

const input = (o: Partial<ProblemInput> = {}): ProblemInput => ({
  metrics: metrics(),
  detail: detail(),
  extras: null,
  pending: null,
  th,
  baseline: null,
  ...o,
});

describe("what needs attention", () => {
  it("says nothing about a healthy host", () => {
    expect(problems(input())).toEqual([]);
  });

  it("files each problem under its section, the critical first", () => {
    const ps = problems(
      input({
        metrics: metrics({ cpuPct: 97 }),
        detail: detail({
          partitions: [{ mount: "/", fstype: "ext4", used: 87, total: 100, inodesUsed: null, inodesTotal: null }],
          failedUnits: 1,
          failedUnitNames: ["nginx.service"],
        }),
        pending: { manager: "apt", updates: 31, security: 12, rebootRequired: true } as PendingUpdates,
      }),
    );
    expect(ps.map((p) => [p.level, p.section, p.id])).toEqual([
      ["crit", "cpu", "cpu"],
      ["crit", "system", "failed"],
      ["warn", "disks", "disk:/"],
      ["warn", "system", "security"],
      ["warn", "system", "reboot"],
    ]);
    expect(ps.find((p) => p.id === "failed")?.note).toBe("nginx.service");
    expect(ps.find((p) => p.id === "disk:/")?.params.pct).toBe(87);
  });

  it("reads the user's thresholds — a disabled bound raises nothing", () => {
    const off = { ...th, disk: { warn: null, crit: null } };
    const d = detail({ partitions: [{ mount: "/", fstype: "ext4", used: 99, total: 100, inodesUsed: null, inodesTotal: null }] });
    expect(problems(input({ detail: d, th: off }))).toEqual([]);
  });

  it("counts interface errors and throttling only when they grew while the page was open", () => {
    const iface = (bad: number) => ({ name: "eth0", rxRate: 0, txRate: 0, rxErrs: 0, rxDrop: bad, txErrs: 0, txDrop: 0 });
    const opened = detail({ netIfaces: [iface(1200)], throttleCount: 5 });
    const baseline = baselineOf(opened);
    // A thousand drops since boot are history, not a problem now.
    expect(problems(input({ detail: opened, baseline }))).toEqual([]);
    const later = detail({ netIfaces: [iface(1238)], throttleCount: 9 });
    const ps = problems(input({ detail: later, baseline }));
    expect(ps.map((p) => [p.id, p.params.n])).toEqual([
      ["throttle", 4],
      ["net:eth0", 38],
    ]);
  });

  it("names the OOM victims and treats an unreadable kernel log as nothing to report", () => {
    const x = { oomKills: 2, oomVictims: [{ name: "postgres" }, { name: "postgres" }, { name: "node" }], smart: [] } as unknown as Extras;
    const [p] = problems(input({ extras: x }));
    expect([p.level, p.section, p.note]).toEqual(["crit", "memory", "postgres, node"]);
    const unknown = { oomKills: null, oomVictims: [], smart: [] } as unknown as Extras;
    expect(problems(input({ extras: unknown }))).toEqual([]);
  });

  it("takes a sensor's own limits before the CPU threshold, and the hottest offender", () => {
    const d = detail({
      sensors: [
        { label: "Core 0", temp: 82, high: 80, crit: 100 },
        { label: "Core 3", temp: 86, high: 80, crit: 100 },
        { label: "nvme", temp: 40, high: 70, crit: 80 },
      ],
    });
    const [p] = problems(input({ detail: d }));
    expect([p.level, p.params.label, p.params.temp]).toEqual(["warn", "Core 3", 86]);
  });

  it("judges load per logical CPU and names the bound it reached", () => {
    const [p] = problems(input({ metrics: metrics({ load1: 9 }) }));
    expect([p.id, p.level, p.params.n, p.params.limit]).toEqual(["load", "crit", 8, "8"]);
    const [w] = problems(input({ metrics: metrics({ load1: 0.75, cpuCount: 1 }), detail: detail({ perCpu: [10] }) }));
    expect([w.level, w.params.load, w.params.limit]).toEqual(["warn", "0.75", "0.7"]);
  });

  it("names the user's load threshold when that is the lower bound", () => {
    const [p] = problems(input({ metrics: metrics({ load1: 3 }), th: { ...th, load: { warn: 2.5, crit: null } } }));
    expect([p.level, p.params.limit]).toEqual(["warn", "2.5"]);
  });

  it("gives every section the worst of its problems and the overview the worst of all", () => {
    const lv = sectionLevels([
      { id: "a", level: "warn", section: "disks", key: "mon.p.disk", params: {} },
      { id: "b", level: "crit", section: "system", key: "mon.p.failed", params: {} },
    ]);
    expect([lv.disks, lv.system, lv.cpu, lv.overview]).toEqual(["warn", "crit", "ok", "crit"]);
  });
});

describe("problems without the detail probe (the status bar)", () => {
  it("files the root disk from the basic probe", () => {
    const ps = problems(input({ detail: null, metrics: metrics({ diskUsed: 96, diskTotal: 100 }) }));
    expect(ps).toEqual([
      expect.objectContaining({ id: "disk:/", level: "crit", section: "disks", params: expect.objectContaining({ mount: "/", pct: 96 }) }),
    ]);
  });

  it("leaves the disks to the partitions when the detail is there", () => {
    const ps = problems(input({ metrics: metrics({ diskUsed: 96, diskTotal: 100 }) }));
    expect(ps.filter((p) => p.section === "disks")).toEqual([]);
  });
});
