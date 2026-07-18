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
  sensorsInstalled: true,
  cpuBreakdown: { user: 10, system: 5, iowait: 2, steal: 3, idle: 80 },
  topProcs: [
    { pid: 1234, user: "root", cpu: 12.5, mem: 3.1, comm: "nginx" },
    { pid: 5678, user: "www", cpu: 4, mem: 1.2, comm: "php-fpm" },
  ],
  topMemProcs: [
    { pid: 99, user: "postgres", cpu: 2, mem: 41, comm: "postgres" },
    { pid: 4321, user: "redis", cpu: 1, mem: 8.5, comm: "redis-server" },
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
  hardware: {
    cpuModel: "Intel Xeon E5-2680 v4",
    cpuCores: 8,
    cpuThreads: 16,
    cpuSockets: 1,
    cpuMhz: 3300,
    arch: "x86_64",
    virt: "kvm",
    machine: "Dell Inc. PowerEdge R740",
    board: "Dell Inc. 0YWR7D",
    bios: "2.8.1",
  },
};

beforeEach(() => {
  resetSettings();
  fetchMetrics.mockReset().mockResolvedValue(metrics);
  fetchMetricsDetail.mockReset().mockResolvedValue(detail);
  fetchPendingUpdates.mockReset().mockResolvedValue(pending);
  fetchExtras.mockReset().mockResolvedValue(extras);
});

describe("MonitoringOverlay", () => {
  it("renders the system block and all detail sections from a live poll", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s1" } });
    expect(await screen.findByTestId("system")).toBeInTheDocument();
    expect(screen.getByTestId("detail-sections")).toBeInTheDocument();
    expect(screen.getByTestId("per-core")).toBeInTheDocument();
    expect(screen.getByTestId("partitions")).toBeInTheDocument();
    expect(screen.getByTestId("tcp-states")).toBeInTheDocument();
    // 13.2: memory composition stacked bar from the detail breakdown.
    expect(screen.getByTestId("mem-composition")).toBeInTheDocument();
    // 13.4: CPU breakdown bar + top-processes table.
    expect(screen.getByTestId("cpu-breakdown")).toBeInTheDocument();
    expect(screen.getByTestId("top-procs")).toBeInTheDocument();
    expect(screen.getByText("nginx")).toBeInTheDocument();
    // Memory section: top-by-memory table (mirrors the CPU top-process table).
    expect(screen.getByTestId("top-mem")).toBeInTheDocument();
    expect(screen.getByText("redis-server")).toBeInTheDocument();
    // Load average header carries a health dot like every other section.
    expect(screen.getByTestId("load-badge")).toBeInTheDocument();
    // Health summary chips in the System block (all green/ok in the fixture).
    expect(screen.getByTestId("health-summary")).toBeInTheDocument();
    // 13.5: per-interface network, per-device disk I/O, sessions.
    expect(screen.getByTestId("net-ifaces")).toBeInTheDocument();
    expect(screen.getByTestId("disk-devs")).toBeInTheDocument();
    expect(screen.getByTestId("sessions")).toBeInTheDocument();
    expect(screen.getByText("eth0")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.50")).toBeInTheDocument();
    // CPU% headline from the metrics poll.
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("surfaces system-health scalars grouped in the system block", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-health" } });
    const sys = await screen.findByTestId("system");
    // Logical group headers within the System block.
    expect(within(sys).getByText("Host")).toBeInTheDocument();
    expect(within(sys).getByText("synced")).toBeInTheDocument();
    expect(within(sys).getByText("120 / 65536")).toBeInTheDocument();
    // The Updates group appears once the lazy pending probe resolves.
    expect(await within(sys).findByText("Updates")).toBeInTheDocument();
  });

  it("shows the temperature sensors table with a per-core heatmap", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-temp" } });
    expect(await screen.findByTestId("sensors-table")).toBeInTheDocument();
    expect(screen.getByText("Package id 0")).toBeInTheDocument();
    // ≥2 "Core N" sensors → per-core temp heatmap.
    expect(screen.getByTestId("core-temps")).toBeInTheDocument();
  });

  it("offers to install lm-sensors when the binary is missing", async () => {
    fetchMetricsDetail.mockResolvedValue({ ...detail, sensors: [], sensorsInstalled: false });
    const onInstallTool = vi.fn();
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-noterm", onInstallTool } });
    const card = await screen.findByTestId("sensors-install");
    expect(card).toBeInTheDocument();
    await fireEvent.click(within(card).getByRole("button"));
    expect(onInstallTool).toHaveBeenCalledWith("sensors");
  });

  it("shows a 'no sensors detected' note (not the install CTA) when lm-sensors is installed but exposes no chips", async () => {
    fetchMetricsDetail.mockResolvedValue({ ...detail, sensors: [], sensorsInstalled: true });
    const onInstallTool = vi.fn();
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-nosens", onInstallTool } });
    expect(await screen.findByTestId("sensors-none")).toBeInTheDocument();
    expect(screen.queryByTestId("sensors-install")).toBeNull();
  });

  // Phase 39 (Windows testing): a Windows host reported no sensors, and the card
  // fell through to "Install lm-sensors" — an apt package, on Windows.
  it("says temperature is unsupported on Windows instead of offering lm-sensors", async () => {
    fetchMetrics.mockResolvedValue({ ...metrics, os: "Windows", cpuTemp: null });
    fetchMetricsDetail.mockResolvedValue({ ...detail, sensors: [], sensorsInstalled: false });
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-win-temp" } });
    expect(await screen.findByTestId("sensors-unsupported")).toBeInTheDocument();
    expect(screen.queryByTestId("sensors-install")).toBeNull();
  });

  // Windows has no load-average concept at all, so the card is hidden rather
  // than rendered as "— / — / —".
  it("hides the load-average card on Windows but keeps it on Linux", async () => {
    fetchMetrics.mockResolvedValue({
      ...metrics,
      os: "Windows",
      load1: null,
      load5: null,
      load15: null,
    });
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-win-load" } });
    // Wait for the poll to land (the sections render) before asserting an absence,
    // otherwise this would pass merely because nothing had rendered yet.
    expect(await screen.findByTestId("detail-sections")).toBeInTheDocument();
    expect(screen.queryByTestId("load-badge")).toBeNull();
    expect(screen.queryByTestId("load-history")).toBeNull();
  });

  it("shows skeletons for delta metrics until the second poll", async () => {
    // First real poll has no per-core/breakdown/ctx/per-device data (needs 2 samples).
    fetchMetricsDetail.mockResolvedValue({
      ...detail,
      perCpu: [],
      cpuBreakdown: null,
      ctxtRate: null,
      intrRate: null,
      diskDevs: [],
    });
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-delta" } });
    await screen.findByTestId("system");
    expect(screen.getByTestId("per-core-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("cpu-breakdown-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("disk-devs-skeleton")).toBeInTheDocument();
    // The real per-core bars are not shown yet.
    expect(screen.queryByTestId("per-core")).toBeNull();
  });

  it("renders an unlimited file-descriptor ceiling as ∞", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s1c" } });
    // fileNrMax is i64::MAX in the fixture → ∞, with the percentage suppressed.
    expect(await screen.findByText(/1,536 \/ ∞ \(—\)/)).toBeInTheDocument();
  });

  it("lazily loads extras (GPU/Docker/SMART/OOM) after the first paint", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-extras" } });
    await screen.findByTestId("system");
    expect(await screen.findByTestId("extras-card")).toBeInTheDocument();
    expect(screen.getByTestId("gpu-list")).toBeInTheDocument();
    expect(screen.getByTestId("smart-list")).toBeInTheDocument();
    expect(screen.getByTestId("docker-list")).toBeInTheDocument();
    expect(screen.getByText("RTX 4090")).toBeInTheDocument();
    expect(fetchExtras).toHaveBeenCalledWith("s-extras");
  });

  it("shows the Hardware group and a virtualization badge from extras (Фаза 20.16)", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-hw" } });
    const hw = await screen.findByTestId("hardware");
    expect(within(hw).getByText("Hardware")).toBeInTheDocument();
    expect(within(hw).getByText("Intel Xeon E5-2680 v4")).toBeInTheDocument();
    expect(within(hw).getByText("8 / 16")).toBeInTheDocument();
    expect(within(hw).getByText("3.30 GHz")).toBeInTheDocument();
    expect(within(hw).getByText("x86_64")).toBeInTheDocument();
    expect(within(hw).getByText("Dell Inc. PowerEdge R740")).toBeInTheDocument();
    expect(within(hw).getByText("Dell Inc. 0YWR7D")).toBeInTheDocument();
    // Guest badge appears in the System header (kvm ≠ bare metal).
    expect(await screen.findByTestId("virt-badge")).toHaveTextContent("kvm");
  });

  it("shows an explicit total-RAM row and 'of total' subtitle (Фаза 20.16)", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-ram" } });
    await screen.findByTestId("system");
    // memTotal is 8 GiB in the fixture → distinct Total row + subtitle by the %.
    expect(await screen.findByText("Total")).toBeInTheDocument();
    expect(screen.getByText(/of 8(\.0)? GiB/)).toBeInTheDocument();
  });

  it("shows the Updates group header with a skeleton while pending loads", async () => {
    let resolve: (v: PendingUpdates) => void = () => {};
    fetchPendingUpdates.mockReturnValue(new Promise<PendingUpdates>((r) => (resolve = r)));
    render(MonitoringOverlay, { props: { open: true, sessionId: "s-upd" } });
    const sys = await screen.findByTestId("system");
    // Header is shown immediately; the body is a skeleton until the probe resolves.
    expect(await within(sys).findByText("Updates")).toBeInTheDocument();
    expect(within(sys).getByTestId("updates-skeleton")).toBeInTheDocument();
    resolve(pending); // let it finish so there are no dangling promises
  });

  it("lazily loads pending updates after the first paint", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s2" } });
    await screen.findByTestId("system");
    // Pending fetch is deferred (~300ms); the manager appears once it resolves.
    expect(await screen.findByText("apt")).toBeInTheDocument();
    expect(fetchPendingUpdates).toHaveBeenCalledWith("s2");
  });

  it("colours a partition red when usage exceeds the limit threshold", async () => {
    settings.statusBarThresholds.disk = { warn: 1, crit: 2 }; // 5% usage → crit
    render(MonitoringOverlay, { props: { open: true, sessionId: "s3" } });
    await screen.findByTestId("partitions");
    const usage = await screen.findByText(/5\.0 GiB \/ 100\.0 GiB \(5%\)/);
    expect(usage).toHaveClass("text-danger");
  });

  it("does not poll while closed", () => {
    render(MonitoringOverlay, { props: { open: false, sessionId: "s4" } });
    expect(fetchMetrics).not.toHaveBeenCalled();
    expect(fetchMetricsDetail).not.toHaveBeenCalled();
  });
});
