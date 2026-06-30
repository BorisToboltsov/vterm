import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Extras, Metrics, MetricsDetail, PendingUpdates } from "./api";

const fetchMetrics = vi.fn();
const fetchMetricsDetail = vi.fn();
const fetchPendingUpdates = vi.fn();
const fetchExtras = vi.fn();
vi.mock("./api", () => ({
  fetchMetrics: (...a: unknown[]) => fetchMetrics(...a),
  fetchMetricsDetail: (...a: unknown[]) => fetchMetricsDetail(...a),
  fetchPendingUpdates: (...a: unknown[]) => fetchPendingUpdates(...a),
  fetchExtras: (...a: unknown[]) => fetchExtras(...a),
}));

import MonitoringOverlay from "./MonitoringOverlay.svelte";
import { resetSettings, settings } from "./settings.svelte";

const metrics: Metrics = {
  os: "Linux",
  prettyName: "Ubuntu 24.04 LTS",
  hostname: "web01",
  user: "root",
  load1: 0.5,
  load5: 0.4,
  load15: 0.3,
  cpuPct: 42,
  memUsed: 2 * 1024 ** 3,
  memTotal: 8 * 1024 ** 3,
  diskUsed: 5 * 1024 ** 3,
  diskTotal: 100 * 1024 ** 3,
  netRxRate: 1024,
  netTxRate: 2048,
  diskReadRate: 0,
  diskWriteRate: 0,
  uptimeSecs: 3600,
  swapUsed: 0,
  swapTotal: 0,
  users: "root",
  ip: "10.0.0.5",
  topProc: "node 87%",
  cpuTemp: 55,
  netConns: 5,
  kernel: "6.1.0",
  serverTime: "14:05 UTC",
};

const detail: MetricsDetail = {
  perCpu: [80, 10, 95, 5],
  memTotal: 8 * 1024 ** 3,
  memFree: 1024 ** 3,
  memAvailable: 4 * 1024 ** 3,
  memBuffers: 256 * 1024 ** 2,
  memCached: 2 * 1024 ** 3,
  topMem: "postgres 12%, node 8%",
  partitions: [
    {
      mount: "/",
      fstype: "ext4",
      used: 5 * 1024 ** 3,
      total: 100 * 1024 ** 3,
      inodesUsed: 123456,
      inodesTotal: 655360,
    },
  ],
  fileNrUsed: 1536,
  fileNrMax: 9223372036854775807,
  ulimitSoft: 1024,
  ulimitHard: 524288,
  psiCpu: { avg10: 1.5, avg60: 0.2, avg300: 0.05 },
  psiMem: null,
  psiIo: { avg10: 0, avg60: 0, avg300: 0 },
  tcp: [
    { state: "ESTAB", count: 12 },
    { state: "LISTEN", count: 8 },
  ],
  sensors: [
    { label: "Package id 0", temp: 55, high: 84, crit: 100 },
    { label: "Core 0", temp: 50, high: 84, crit: 100 },
    { label: "Core 1", temp: 52, high: 84, crit: 100 },
  ],
  cpuBreakdown: { user: 10, system: 5, iowait: 2, steal: 3, idle: 80 },
  topProcs: [
    { pid: 1234, user: "root", cpu: 12.5, mem: 3.1, comm: "nginx" },
    { pid: 5678, user: "www", cpu: 4, mem: 1.2, comm: "php-fpm" },
  ],
  failedUnits: 1,
  listenPorts: 9,
  conntrack: 120,
  conntrackMax: 65536,
  timeSynced: true,
  netIfaces: [{ name: "eth0", rxRate: 1024, txRate: 2048, rxErrs: 0, rxDrop: 0, txErrs: 0, txDrop: 0 }],
  diskDevs: [{ name: "sda", readRate: 4096, writeRate: 8192 }],
  sessions: [{ user: "root", tty: "pts/0", from: "192.168.1.50", login: "2026-06-29 14:00" }],
  ctxtRate: 5000,
  intrRate: 3000,
  procsRunning: 2,
  procsBlocked: 0,
};

const pending: PendingUpdates = {
  manager: "apt",
  updates: 12,
  security: 3,
  rebootRequired: true,
};

const extras: Extras = {
  gpus: [{ name: "RTX 4090", util: 35, memUsed: 1024, memTotal: 24576, temp: 61 }],
  docker: [{ name: "web", cpu: 12.5, mem: "1.2GiB / 3.8GiB" }],
  smart: [{ device: "sda", health: "PASSED", temp: 38, powerOnHours: 12345 }],
  oomKills: 2,
};

beforeEach(() => {
  resetSettings();
  fetchMetrics.mockReset().mockResolvedValue(metrics);
  fetchMetricsDetail.mockReset().mockResolvedValue(detail);
  fetchPendingUpdates.mockReset().mockResolvedValue(pending);
  fetchExtras.mockReset().mockResolvedValue(extras);
});

describe("MonitoringOverlay", () => {
  it("always shows the system block and KPI tiles from a live poll", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s1" } });
    expect(await screen.findByTestId("system")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-tiles")).toBeInTheDocument();
    expect(screen.getByTestId("tile-cpu")).toBeInTheDocument();
    // CPU% headline shows in the gauge text even in compact mode.
    expect(screen.getAllByText("42%").length).toBeGreaterThan(0);
  });

  it("hides detail sections in compact mode and reveals them when detailed", async () => {
    settings.monitorExpanded = false;
    const { rerender } = render(MonitoringOverlay, { props: { open: true, sessionId: "s1b" } });
    await screen.findByTestId("kpi-tiles");
    expect(screen.queryByTestId("detail-sections")).toBeNull();
    expect(screen.queryByTestId("per-core")).toBeNull();

    settings.monitorExpanded = true;
    await rerender({ open: true, sessionId: "s1b" });
    expect(await screen.findByTestId("detail-sections")).toBeInTheDocument();
    expect(screen.getByTestId("per-core")).toBeInTheDocument();
    expect(screen.getByTestId("partitions")).toBeInTheDocument();
    expect(screen.getByTestId("tcp-states")).toBeInTheDocument();
    // 13.2: memory composition stacked bar from the detail breakdown.
    expect(screen.getByTestId("mem-composition")).toBeInTheDocument();
    // 13.4: CPU breakdown bar + top-processes table.
    expect(screen.getByTestId("cpu-breakdown")).toBeInTheDocument();
    expect(screen.getByTestId("top-procs")).toBeInTheDocument();
    expect(screen.getByText("nginx")).toBeInTheDocument();
    // 13.5: per-interface network, per-device disk I/O, sessions.
    expect(screen.getByTestId("net-ifaces")).toBeInTheDocument();
    expect(screen.getByTestId("disk-devs")).toBeInTheDocument();
    expect(screen.getByTestId("sessions")).toBeInTheDocument();
    expect(screen.getByText("eth0")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.50")).toBeInTheDocument();
  });

  it("surfaces system-health scalars in the always-visible system block", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-health" } });
    const sys = await screen.findByTestId("system");
    // Failed units (>0 → danger) and time-sync status show regardless of mode.
    expect(within(sys).getByText("synced")).toBeInTheDocument();
    expect(within(sys).getByText("120 / 65536")).toBeInTheDocument();
  });

  it("shows the temperature sensors table in detailed mode", async () => {
    settings.monitorExpanded = true;
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-temp" } });
    expect(await screen.findByTestId("sensors-table")).toBeInTheDocument();
    expect(screen.getByText("Package id 0")).toBeInTheDocument();
    // ≥2 "Core N" sensors → per-core temp heatmap.
    expect(screen.getByTestId("core-temps")).toBeInTheDocument();
  });

  it("offers to install lm-sensors when no sensor data is available", async () => {
    settings.monitorExpanded = true;
    fetchMetricsDetail.mockResolvedValue({ ...detail, sensors: [] });
    const onInstallTool = vi.fn();
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-noterm", onInstallTool } });
    const card = await screen.findByTestId("sensors-install");
    expect(card).toBeInTheDocument();
    await fireEvent.click(within(card).getByRole("button"));
    expect(onInstallTool).toHaveBeenCalledWith("sensors");
  });

  it("renders an unlimited file-descriptor ceiling as ∞", async () => {
    settings.monitorExpanded = true;
    render(MonitoringOverlay, { props: { open: true, sessionId: "s1c" } });
    // fileNrMax is i64::MAX in the fixture → ∞, with the percentage suppressed.
    expect(await screen.findByText(/1,536 \/ ∞ \(—\)/)).toBeInTheDocument();
  });

  it("lazily loads extras (GPU/Docker/SMART/OOM) after the first paint", async () => {
    settings.monitorExpanded = true;
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-extras" } });
    await screen.findByTestId("kpi-tiles");
    expect(await screen.findByTestId("extras-card")).toBeInTheDocument();
    expect(screen.getByTestId("gpu-list")).toBeInTheDocument();
    expect(screen.getByTestId("smart-list")).toBeInTheDocument();
    expect(screen.getByTestId("docker-list")).toBeInTheDocument();
    expect(screen.getByText("RTX 4090")).toBeInTheDocument();
    expect(fetchExtras).toHaveBeenCalledWith("s-extras");
  });

  it("lazily loads pending updates after the first paint", async () => {
    settings.monitorExpanded = true;
    render(MonitoringOverlay, { props: { open: true, sessionId: "s2" } });
    await screen.findByTestId("kpi-tiles");
    // Pending fetch is deferred (~300ms); the manager appears once it resolves.
    expect(await screen.findByText("apt")).toBeInTheDocument();
    expect(fetchPendingUpdates).toHaveBeenCalledWith("s2");
  });

  it("colours a partition red when usage exceeds the limit threshold", async () => {
    settings.monitorExpanded = true;
    settings.statusBarThresholds.disk = { warn: 1, crit: 2 }; // 5% usage → crit
    render(MonitoringOverlay, { props: { open: true, sessionId: "s3" } });
    await screen.findByText("Filesystems");
    // The "/" partition usage figure is red. Include the "(5%)" so this matches
    // the partition row, not the disk KPI tile's "5.0 GiB / 100.0 GiB" sub-line.
    const usage = await screen.findByText(/5\.0 GiB \/ 100\.0 GiB \(5%\)/);
    expect(usage).toHaveClass("text-danger");
  });

  it("does not poll while closed", () => {
    render(MonitoringOverlay, { props: { open: false, sessionId: "s4" } });
    expect(fetchMetrics).not.toHaveBeenCalled();
    expect(fetchMetricsDetail).not.toHaveBeenCalled();
  });
});
