import { describe, expect, it } from "vitest";
import type { Extras, LiveExtras, Metrics, MetricsDetail } from "../api";
import { fullestPartition, hottest, navValue, shownSections, wantsLive } from "./monsections";

const m = { cpuPct: 34.4, memUsed: 6, memTotal: 10, netRxRate: 2_200_000, cpuTemp: 51 } as Metrics;
const d = {
  partitions: [
    { mount: "/boot", fstype: "vfat", used: 1, total: 5, inodesUsed: null, inodesTotal: null },
    { mount: "/", fstype: "ext4", used: 87, total: 100, inodesUsed: null, inodesTotal: null },
    { mount: "/empty", fstype: "ext4", used: 0, total: 0, inodesUsed: null, inodesTotal: null },
  ],
  sensors: [
    { label: "Core 0", temp: 55, high: null, crit: null },
    { label: "Core 3", temp: 63, high: null, crit: null },
  ],
} as unknown as MetricsDetail;
const x = { gpus: [], docker: [{ name: "api" }] } as unknown as Extras;

describe("the monitoring navigation", () => {
  it("offers no section for what the host does not have", () => {
    const s = shownSections({ metrics: m, detail: d, extras: x, live: null });
    expect(s).toContain("containers");
    expect(s).not.toContain("gpu");
    // Temperature stays — its page explains why there is nothing to read.
    expect(shownSections({ metrics: m, detail: null, extras: null, live: null })).toEqual([
      "overview", "cpu", "memory", "disks", "network", "temperature", "processes", "system",
    ]);
  });

  it("prefers the live list once it has been polled", () => {
    const live = { gpus: [{ util: 41 }], docker: [] } as unknown as LiveExtras;
    const s = shownSections({ metrics: m, detail: d, extras: x, live });
    expect(s).toContain("gpu");
    expect(s).not.toContain("containers");
    expect(navValue("gpu", { metrics: m, detail: d, extras: x, live })).toBe("41%");
  });

  it("shows the short value of each section, and nothing it does not know", () => {
    const all = { metrics: m, detail: d, extras: x, live: null };
    expect(navValue("cpu", all)).toBe("34%");
    expect(navValue("memory", all)).toBe("60%");
    expect(navValue("disks", all)).toBe("87%");
    expect(navValue("network", all)).toBe("2.1 MB/s");
    expect(navValue("temperature", all)).toBe("63°");
    expect(navValue("containers", all)).toBe("1");
    expect(navValue("system", all)).toBeNull();
    expect(navValue("cpu", { metrics: null, detail: null, extras: null, live: null })).toBeNull();
  });

  it("finds the fullest partition and the hottest reading", () => {
    expect(fullestPartition(d)?.mount).toBe("/");
    expect(fullestPartition(null)).toBeNull();
    expect(hottest(m, d)).toEqual({ label: "Core 3", temp: 63 });
    expect(hottest(m, null)).toEqual({ label: "CPU", temp: 51 });
    expect(hottest({ cpuTemp: null } as Metrics, null)).toBeNull();
  });

  it("polls GPUs and containers only while one of them is on screen", () => {
    expect(wantsLive("containers") && wantsLive("gpu")).toBe(true);
    expect(wantsLive("overview")).toBe(false);
  });
});
