import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Metrics, MetricsDetail, PendingUpdates } from "./api";

const fetchMetrics = vi.fn();
const fetchMetricsDetail = vi.fn();
const fetchPendingUpdates = vi.fn();
vi.mock("./api", () => ({
  fetchMetrics: (...a: unknown[]) => fetchMetrics(...a),
  fetchMetricsDetail: (...a: unknown[]) => fetchMetricsDetail(...a),
  fetchPendingUpdates: (...a: unknown[]) => fetchPendingUpdates(...a),
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

beforeEach(() => {
  resetSettings();
  fetchMetrics.mockReset().mockResolvedValue(metrics);
  fetchMetricsDetail.mockReset().mockResolvedValue(detail);
  fetchPendingUpdates.mockReset().mockResolvedValue(pending);
});

describe("MonitoringOverlay", () => {
  it("renders metric cards from a live poll", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s1" } });
    expect(await screen.findByText("Процессор")).toBeInTheDocument();
    expect(screen.getByText("Память")).toBeInTheDocument();
    expect(screen.getByText("Файловые системы")).toBeInTheDocument();
    expect(screen.getByTestId("per-core")).toBeInTheDocument();
    expect(screen.getByTestId("partitions")).toBeInTheDocument();
    expect(screen.getByTestId("tcp-states")).toBeInTheDocument();
    // headline CPU% from the metrics poll
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("lazily loads pending updates after the first paint", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s2" } });
    await screen.findByText("Процессор");
    // Pending fetch is deferred (~300ms); the manager appears once it resolves.
    expect(await screen.findByText("apt")).toBeInTheDocument();
    expect(fetchPendingUpdates).toHaveBeenCalledWith("s2");
  });

  it("colours a partition red when usage exceeds the limit threshold", async () => {
    settings.statusBarThresholds.disk = { warn: 1, crit: 2 }; // 5% usage → crit
    render(MonitoringOverlay, { props: { open: true, sessionId: "s3" } });
    await screen.findByText("Файловые системы");
    // The "/" partition usage figure is red.
    const usage = await screen.findByText(/5\.0 GiB \/ 100\.0 GiB/);
    expect(usage).toHaveClass("text-danger");
  });

  it("does not poll while closed", () => {
    render(MonitoringOverlay, { props: { open: false, sessionId: "s4" } });
    expect(fetchMetrics).not.toHaveBeenCalled();
    expect(fetchMetricsDetail).not.toHaveBeenCalled();
  });
});
