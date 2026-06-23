import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Metrics } from "./api";

const fetchMetrics = vi.fn();
vi.mock("./api", () => ({ fetchMetrics: (...a: unknown[]) => fetchMetrics(...a) }));

import StatusBar from "./StatusBar.svelte";
import { resetSettings, settings } from "./settings.svelte";
import { applyProgress, clearTransfers } from "./stores/transfers.svelte";
import { layout, resetLayout } from "./stores/layout.svelte";

const linux: Metrics = {
  os: "Linux",
  prettyName: "Ubuntu 24.04 LTS",
  hostname: "web01",
  user: "root",
  load1: 0.15,
  load5: 0.2,
  load15: 0.3,
  cpuPct: 42,
  memUsed: 2 * 1024 ** 3,
  memTotal: 8 * 1024 ** 3,
  diskUsed: 5 * 1024 ** 3,
  diskTotal: 100 * 1024 ** 3,
  netTxRate: 2 * 1024 ** 2, // 2.0 MB/s
  netRxRate: 512 * 1024, // 512 KB/s
  diskReadRate: 1024 ** 2, // 1.0 MB/s
  diskWriteRate: 256 * 1024, // 256 KB/s
  uptimeSecs: 90061, // up 1d 1h
  swapUsed: 1 * 1024 ** 3,
  swapTotal: 2 * 1024 ** 3, // 50%
  users: "root alice",
  ip: "10.0.0.5",
  topProc: "node 87%",
  cpuTemp: 56,
  netConns: 42,
  kernel: "6.1.0",
  serverTime: "14:05 UTC",
};

beforeEach(() => {
  resetSettings();
  resetLayout();
  clearTransfers();
  fetchMetrics.mockReset();
});

describe("StatusBar — compact (default)", () => {
  it("shows OS icon + percentages, hides names/bytes/sparkline", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s1" } });

    expect(await screen.findByTitle("Linux")).toBeInTheDocument();
    expect(screen.getByText("root@web01")).toBeInTheDocument();
    // Compact: percentages only — no pretty name, no byte totals, no chart.
    expect(screen.queryByText("Ubuntu 24.04 LTS")).toBeNull();
    expect(screen.queryByTestId("cpu-chart")).toBeNull();
    expect(screen.getByText("42%")).toBeInTheDocument(); // CPU
    expect(screen.getByText("25%")).toBeInTheDocument(); // RAM 2/8
    expect(screen.getByText("5%")).toBeInTheDocument(); // disk 5/100
    // Load average is its own group; network shows up/down rates.
    expect(screen.getByText("0.15 0.20 0.30")).toBeInTheDocument();
    expect(screen.getByText("2.0 MB/s")).toBeInTheDocument();
    expect(screen.getByText("512 KB/s")).toBeInTheDocument();
  });

  it("the toggle switches to the expanded view", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s2" } });
    await screen.findByTitle("Linux");

    await userEvent.click(screen.getByTestId("statusbar-toggle"));
    expect(screen.getByText("Ubuntu 24.04 LTS")).toBeInTheDocument();
    expect(screen.getByTestId("cpu-chart")).toBeInTheDocument();
    expect(screen.getByText("2.0 GiB / 8.0 GiB (25%)")).toBeInTheDocument();
  });

  it("shows the extended metrics (uptime, ip, temp, users count) with data-gating", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "ext" } });
    await screen.findByTitle("Linux");
    expect(screen.getByText("1d 1h")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5")).toBeInTheDocument();
    expect(screen.getByText("56°C")).toBeInTheDocument();
    expect(screen.getByText("node 87%")).toBeInTheDocument();
    expect(screen.getByText("6.1.0")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument(); // connections
    // Users: count shown, names in the tooltip (newline-separated).
    expect(screen.getByTitle(/Logged-in users:[\s\S]*root[\s\S]*alice/)).toBeInTheDocument();
  });

  it("hides a metric group when its toggle is off", async () => {
    settings.statusBarItems.disk = false;
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s3" } });
    await screen.findByTitle("Linux");
    expect(screen.queryByText("5%")).toBeNull(); // disk hidden
    expect(screen.getByText("25%")).toBeInTheDocument(); // RAM still shown
  });
});

describe("StatusBar — expanded", () => {
  beforeEach(() => (settings.statusBarExpanded = true));

  it("renders names, byte totals and the CPU sparkline", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "e1" } });

    expect(await screen.findByText("Ubuntu 24.04 LTS")).toBeInTheDocument();
    expect(screen.getByTitle("Linux")).toBeInTheDocument();
    expect(screen.getByText("root@web01")).toBeInTheDocument();
    expect(screen.getByText("2.0 GiB / 8.0 GiB (25%)")).toBeInTheDocument();
    expect(screen.getByText("95.0 GiB free / 100.0 GiB")).toBeInTheDocument();
  });

  it("renders the CPU sparkline with a stable bar count", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "e2" } });

    const chart = await screen.findByTestId("cpu-chart");
    const bars = chart.querySelectorAll("span");
    expect(bars.length).toBe(12);
    const last = bars[bars.length - 1] as HTMLElement;
    expect(last.style.height).not.toBe("0%");
    expect(last.style.height).not.toBe("");
  });
});

describe("StatusBar — thresholds & monitoring", () => {
  it("colours a metric amber at the warn threshold and red at the limit", async () => {
    settings.statusBarThresholds.cpu = { warn: 40, crit: 90 };
    fetchMetrics.mockResolvedValue(linux); // cpuPct = 42
    const { unmount } = render(StatusBar, { props: { sessionId: "th1" } });
    await screen.findByTitle("Linux");
    expect(screen.getByText("42%")).toHaveClass("text-warn");
    unmount();

    settings.statusBarThresholds.cpu = { warn: 10, crit: 40 };
    render(StatusBar, { props: { sessionId: "th2" } });
    await screen.findByTitle("Linux");
    expect(screen.getByText("42%")).toHaveClass("text-danger");
  });

  it("does not colour a metric below its thresholds", async () => {
    settings.statusBarThresholds.cpu = { warn: 80, crit: 95 };
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "th3" } });
    await screen.findByTitle("Linux");
    const cpu = screen.getByText("42%");
    expect(cpu).not.toHaveClass("text-warn");
    expect(cpu).not.toHaveClass("text-danger");
  });

  it("fires onOpenMonitoring when the monitoring button is clicked", async () => {
    const onOpenMonitoring = vi.fn();
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "mon", onOpenMonitoring } });
    await screen.findByTitle("Linux");
    await userEvent.click(screen.getByTestId("open-monitoring"));
    expect(onOpenMonitoring).toHaveBeenCalledOnce();
  });
});

describe("StatusBar — transfers & states", () => {
  it("shows the SFTP transfer indicator from the shared store", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "t1" } });
    await screen.findByTitle("Linux");

    expect(screen.queryByTestId("transfer-indicator")).toBeNull();
    applyProgress({
      id: "x",
      name: "f.txt",
      direction: "upload",
      transferred: 1,
      total: 2,
      done: false,
      isFolder: false,
    });
    expect(await screen.findByTestId("transfer-indicator")).toBeInTheDocument();
  });

  it("clicking the indicator expands the SFTP panel", async () => {
    layout.sftpCollapsed = true;
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "t2" } });
    await screen.findByTitle("Linux");
    applyProgress({
      id: "y",
      name: "f",
      direction: "download",
      transferred: 1,
      total: 4,
      done: false,
      isFolder: false,
    });
    await userEvent.click(await screen.findByTestId("transfer-indicator"));
    expect(layout.sftpCollapsed).toBe(false);
  });

  it("shows an error state when the probe fails", async () => {
    fetchMetrics.mockRejectedValue(new Error("no session"));
    render(StatusBar, { props: { sessionId: "s4" } });
    expect(await screen.findByText("Metrics unavailable")).toBeInTheDocument();
  });

  it("renders dashes/unknown when metric fields are missing", async () => {
    const sparse: Metrics = {
      os: "",
      prettyName: "",
      hostname: "",
      user: "",
      load1: null,
      load5: null,
      load15: null,
      cpuPct: null,
      memUsed: null,
      memTotal: null,
      diskUsed: null,
      diskTotal: null,
      netTxRate: null,
      netRxRate: null,
      diskReadRate: null,
      diskWriteRate: null,
      uptimeSecs: null,
      swapUsed: null,
      swapTotal: null,
      users: "",
      ip: "",
      topProc: "",
      cpuTemp: null,
      netConns: null,
      kernel: "",
      serverTime: "",
    };
    fetchMetrics.mockResolvedValue(sparse);
    render(StatusBar, { props: { sessionId: "s5" } });
    expect(await screen.findByTitle("Unknown OS")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
