import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { Metrics } from "./api";

const fetchMetrics = vi.fn();
vi.mock("./api", () => ({ fetchMetrics: (...a: unknown[]) => fetchMetrics(...a) }));

import StatusBar from "./StatusBar.svelte";

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
};

describe("StatusBar", () => {
  it("renders OS, user@host and formatted resource usage", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s1" } });

    expect(await screen.findByText("Ubuntu 24.04 LTS")).toBeInTheDocument();
    // OS icon rendered from the registry, labelled with the OS family.
    expect(screen.getByTitle("Linux")).toBeInTheDocument();
    expect(screen.getByText("root@web01")).toBeInTheDocument();
    // RAM: used / total (pct) combined into one value element.
    expect(screen.getByText("2.0 GiB / 8.0 GiB (25%)")).toBeInTheDocument();
    // Disk: free / total combined into one value element (free = 95 GiB).
    expect(screen.getByText("95.0 GiB free / 100.0 GiB")).toBeInTheDocument();
  });

  it("renders the CPU sparkline and reflects the latest sample", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "cpu" } });

    const chart = await screen.findByTestId("cpu-chart");
    const bars = chart.querySelectorAll("span");
    // Fixed-width chart: a stable number of bars (zero-padded history).
    expect(bars.length).toBe(12);
    // The newest bar (rightmost) carries the latest 42% sample as a height.
    const last = bars[bars.length - 1] as HTMLElement;
    expect(last.style.height).not.toBe("0%");
    expect(last.style.height).not.toBe("");
  });

  it("shows an error state when the probe fails", async () => {
    fetchMetrics.mockRejectedValue(new Error("no session"));
    render(StatusBar, { props: { sessionId: "s2" } });
    expect(await screen.findByText("Metrics unavailable")).toBeInTheDocument();
  });

  it("renders dashes/omissions when metric fields are missing", async () => {
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
    };
    fetchMetrics.mockResolvedValue(sparse);
    render(StatusBar, { props: { sessionId: "s3" } });
    // Unknown OS marker, and a dash for CPU%.
    expect(await screen.findByTitle("Unknown OS")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
