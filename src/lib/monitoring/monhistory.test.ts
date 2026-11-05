import { describe, expect, it } from "vitest";
import type { Metrics, MetricsDetail } from "../api";
import { keysOf, latest, peak, pushReadings, readingsOf, series } from "./monhistory";

describe("the monitoring history", () => {
  it("appends a poll, keeps the window, and gives a series that got nothing a gap", () => {
    let h = pushReadings({}, 0, { cpu: 10, "proc.7.cpu": 50 }, 3);
    h = pushReadings(h, 1, { cpu: 20 }, 3);
    expect(series(h, "proc.7.cpu").map((x) => x.v)).toEqual([50, null]);
    h = pushReadings(h, 2, { cpu: 30 }, 3);
    h = pushReadings(h, 3, { cpu: 40 }, 3);
    expect(series(h, "cpu").map((x) => x.s)).toEqual([1, 2, 3]);
    // Nothing known left in the window — the series goes.
    expect(keysOf(h, "proc.")).toEqual([]);
  });

  it("never stores a non-finite value as a reading", () => {
    const h = pushReadings({}, 0, { a: NaN, b: Infinity, c: 1 });
    expect(Object.keys(h)).toEqual(["c"]);
  });

  it("reads the newest known value and the peak", () => {
    let h = pushReadings({}, 0, { cpu: 71 });
    h = pushReadings(h, 1, { cpu: 30 });
    h = pushReadings(h, 2, { cpu: null });
    expect(latest(h, "cpu")).toBe(30);
    expect(peak(h, "cpu")).toEqual({ v: 71, s: 0 });
    expect(latest(h, "none")).toBeNull();
    expect(peak(h, "none")).toBeNull();
  });

  it("builds per-item series from the probes that already run", () => {
    const m = { cpuPct: 34, memUsed: 8, memTotal: 16, swapUsed: 0, swapTotal: 0, diskUsed: 30, diskTotal: 120 } as Metrics;
    const d = {
      perCpu: [10, 90],
      netIfaces: [{ name: "eth0", rxRate: 5, txRate: 6, rxErrs: 1, rxDrop: 2, txErrs: 0, txDrop: 0 }],
      diskDevs: [{ name: "sda", readRate: 1, writeRate: 2, utilPct: 40, awaitMs: 3 }],
      sensors: [{ label: "Core 0", temp: 55, high: 80, crit: 100 }],
      topProcs: [{ pid: 7, user: "u", cpu: 38, mem: 12, comm: "pg" }],
      topMemProcs: [],
      partitions: [{ mount: "/", fstype: "ext4", used: 87, total: 100, inodesUsed: null, inodesTotal: null }],
      psiCpu: null,
      psiMem: null,
      psiIo: null,
      cpuBreakdown: null,
      memTotal: null,
      memFree: null,
      swapInRate: null,
      swapOutRate: null,
    } as unknown as MetricsDetail;
    const r = readingsOf(m, d, { gpus: [], docker: [{ name: "api", cpu: 3, mem: "", memUsed: 9, memLimit: null, cpuLimit: null }] });
    expect(r.cpu).toBe(34);
    expect(r.ram).toBe(50);
    // The root disk from the basic probe — the status bar's tile draws it.
    expect(r.disk).toBe(25);
    // No swap configured: unknown, not 0 %.
    expect(r.swap).toBeNull();
    expect(r["core.1"]).toBe(90);
    expect(r["if.eth0.bad"]).toBe(3);
    expect(r["dev.sda.util"]).toBe(40);
    expect(r["temp.Core 0"]).toBe(55);
    expect(r["proc.7.cpu"]).toBe(38);
    expect(r["fs./"]).toBe(87);
    expect(r["ctr.api.mem"]).toBe(9);
    expect(r["brk.user"]).toBeNull();
  });
});
