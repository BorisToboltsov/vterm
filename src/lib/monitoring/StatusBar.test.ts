import { fireEvent, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Metrics } from "../api";

const fetchMetrics = vi.fn();
const sftpCancel = vi.fn(async () => {});
vi.mock("../api", () => ({
  fetchMetrics: (...a: unknown[]) => fetchMetrics(...a),
  sftpCancel: (...a: unknown[]) => sftpCancel(...(a as [])),
}));

import StatusBar from "./StatusBar.svelte";
import { resetSettings, settings } from "../settings/settings.svelte";
import { applyProgress, clearTransfers } from "../stores/transfers.svelte";
import { layout, resetLayout } from "../stores/layout.svelte";
import { forgetMetrics } from "../stores/metricsfeed.svelte";
import { BAR_ORDER } from "./barmodel";

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
  swapUsed: 0.5 * 1024 ** 3,
  swapTotal: 2 * 1024 ** 3, // 25% — under every threshold: a calm host
  users: "root alice",
  ip: "10.0.0.5",
  topProc: "node 87%",
  cpuTemp: 56,
  netConns: 42,
  kernel: "6.1.0",
  serverTime: "14:05 UTC",
  cpuCount: 4,
};

const sessions = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "x1", "x2"];
beforeEach(() => {
  resetSettings();
  // Every group on, compact — each test controls its own inputs; the expanded
  // describe below flips the view for its own cases.
  settings.statusBarExpanded = false;
  for (const k of Object.keys(settings.statusBarItems) as (keyof typeof settings.statusBarItems)[]) {
    settings.statusBarItems[k] = true;
  }
  resetLayout();
  clearTransfers();
  fetchMetrics.mockReset();
  for (const id of sessions) forgetMetrics(id);
});
afterEach(() => {
  for (const id of sessions) forgetMetrics(id);
});

/** The text of a group, its parts joined: "42%", "512 KB/s". */
const groupText = (g: string) => (screen.getByTestId(`bar-${g}`).textContent ?? "").replace(/\s+/g, " ").trim();

describe("StatusBar — the row", () => {
  it("shows the host's verdict, then the groups in bar order", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s1" } });
    expect(await screen.findByTestId("bar-verdict")).toHaveAttribute("data-level", "ok");
    const order = [...document.querySelectorAll("[data-group]")].map((el) => el.getAttribute("data-group"));
    expect(order).toEqual(BAR_ORDER);
  });

  it("compact: icons and numbers, the unit apart from the number", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s1" } });
    await screen.findByTestId("bar-cpu");
    expect(groupText("cpu")).toBe("42%");
    expect(groupText("ram")).toBe("25%");
    expect(groupText("disk")).toBe("5%");
    expect(groupText("net")).toBe("512KB/s 2.0MB/s");
    expect(groupText("load")).toBe("0.15");
    expect(groupText("host")).toBe("root@web01");
    // Compact: no pretty name, no byte totals, no chart.
    expect(screen.queryByText("Ubuntu 24.04 LTS")).toBeNull();
    expect(screen.queryByTestId("cpu-chart")).toBeNull();
    // The unit is drawn dimmer, apart from the number.
    const unit = within(screen.getByTestId("bar-cpu")).getByText("%");
    expect(unit).toHaveClass("text-muted");
  });

  it("expanded: names, byte totals, the free space in the user's language, and the CPU line", async () => {
    settings.statusBarExpanded = true;
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s2" } });
    expect(await screen.findByText("Ubuntu 24.04 LTS")).toBeInTheDocument();
    expect(screen.getByTestId("cpu-chart")).toBeInTheDocument();
    expect(screen.getByText("2.0 GiB / 8.0 GiB")).toBeInTheDocument();
    expect(screen.getByText("95.0 GiB free")).toBeInTheDocument();
    expect(groupText("load")).toBe("0.15 0.20 0.30");
  });

  it("the toggle switches the view", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s3" } });
    await screen.findByTestId("bar-cpu");
    await userEvent.click(screen.getByTestId("statusbar-toggle"));
    expect(settings.statusBarExpanded).toBe(true);
    expect(screen.getByText("Ubuntu 24.04 LTS")).toBeInTheDocument();
  });

  it("hides a group whose setting is off, and one the host does not report", async () => {
    settings.statusBarItems.disk = false;
    fetchMetrics.mockResolvedValue({ ...linux, cpuTemp: null });
    render(StatusBar, { props: { sessionId: "s4" } });
    await screen.findByTestId("bar-cpu");
    expect(screen.queryByTestId("bar-disk")).toBeNull();
    expect(screen.queryByTestId("bar-cpuTemp")).toBeNull();
    expect(screen.getByTestId("bar-ram")).toBeInTheDocument();
  });

  it("keeps «⋯» out of sight while nothing has left the row", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s5" } });
    await screen.findByTestId("bar-cpu");
    const more = screen.getByTestId("bar-more");
    expect(more).toHaveAttribute("aria-hidden", "true");
    expect(more).toHaveClass("invisible");
  });
});

describe("StatusBar — opening the monitoring page", () => {
  it("a group opens its section; the verdict, the overview", async () => {
    const onopen = vi.fn();
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s1", onopen } });
    await userEvent.click(await screen.findByTestId("bar-cpu"));
    await userEvent.click(screen.getByTestId("bar-cpuTemp"));
    await userEvent.click(screen.getByTestId("bar-topProc"));
    await userEvent.click(screen.getByTestId("bar-net"));
    await userEvent.click(screen.getByTestId("bar-verdict"));
    expect(onopen.mock.calls.map((c) => c[0])).toEqual(["cpu", "temperature", "processes", "network", "overview"]);
  });

  it("hovering a group with a history raises its tile; leaving drops it", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s2" } });
    const cpu = await screen.findByTestId("bar-cpu");
    await fireEvent.pointerEnter(cpu);
    const tile = screen.getByTestId("bar-tile");
    expect(tile).toHaveAttribute("data-group", "cpu");
    expect(tile).toHaveTextContent("CPU");
    expect(tile).toHaveTextContent("42%");
    expect(tile).toHaveTextContent("load 0.15 · threads: 4");
    await fireEvent.pointerLeave(cpu);
    expect(screen.queryByTestId("bar-tile")).toBeNull();
    // The network's tile: receive as the number, send under it.
    await fireEvent.pointerEnter(screen.getByTestId("bar-net"));
    expect(screen.getByTestId("bar-tile")).toHaveTextContent("512KB/s");
    expect(screen.getByTestId("bar-tile")).toHaveTextContent("↑ 2.0 MB/s");
  });

  it("a group without a history keeps its tooltip, and no tile", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s3" } });
    const users = await screen.findByTestId("bar-users");
    vi.useFakeTimers();
    await fireEvent.mouseEnter(users);
    vi.advanceTimersByTime(550);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Logged-in users:[\s\S]*root[\s\S]*alice/);
    vi.useRealTimers();
    await fireEvent.pointerEnter(users);
    expect(screen.queryByTestId("bar-tile")).toBeNull();
  });
});

describe("StatusBar — thresholds and problems", () => {
  it("colours a number amber at the warn threshold and red at the limit", async () => {
    settings.statusBarThresholds.cpu = { warn: 40, crit: 90 };
    fetchMetrics.mockResolvedValue(linux); // cpuPct = 42
    const { unmount } = render(StatusBar, { props: { sessionId: "s4" } });
    await screen.findByTestId("bar-cpu");
    expect(screen.getByTestId("bar-cpu").querySelector(".text-warn")).not.toBeNull();
    unmount();

    settings.statusBarThresholds.cpu = { warn: 10, crit: 40 };
    render(StatusBar, { props: { sessionId: "s4" } });
    await screen.findByTestId("bar-cpu");
    expect(screen.getByTestId("bar-cpu").querySelector(".text-danger")).not.toBeNull();
  });

  it("does not colour a number below its thresholds", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s5" } });
    const cpu = await screen.findByTestId("bar-cpu");
    expect(cpu.querySelector(".text-warn, .text-danger")).toBeNull();
  });

  it("colours load by the threads too, as the screensaver does", async () => {
    fetchMetrics.mockResolvedValue({ ...linux, load1: 3.2 }); // 0.8 per thread on 4
    render(StatusBar, { props: { sessionId: "s6" } });
    const load = await screen.findByTestId("bar-load");
    expect(load.querySelector(".text-warn")).not.toBeNull();
  });

  it("pins a problems chip that opens the overview, and turns the verdict", async () => {
    const onopen = vi.fn();
    fetchMetrics.mockResolvedValue({ ...linux, diskUsed: 96 * 1024 ** 3 });
    render(StatusBar, { props: { sessionId: "s7", onopen } });
    const chip = await screen.findByTestId("bar-problems");
    expect(chip).toHaveAttribute("data-level", "crit");
    expect(screen.getByTestId("bar-verdict")).toHaveAttribute("data-level", "crit");
    // A narrow bar (jsdom measures 0) says only how many.
    expect(chip).toHaveTextContent("1");
    expect(chip).toHaveAttribute("aria-label", "/ is 96% full (96.0 GiB of 100.0 GiB)");
    await userEvent.click(chip);
    expect(onopen).toHaveBeenCalledWith("overview");
  });

  it("has no chip on a calm host", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s8" } });
    await screen.findByTestId("bar-cpu");
    expect(screen.queryByTestId("bar-problems")).toBeNull();
  });
});

describe("StatusBar — the feed", () => {
  it("shows a skeleton until the first reading, then the row", async () => {
    let answer: (m: Metrics) => void = () => {};
    fetchMetrics.mockReturnValue(new Promise<Metrics>((r) => (answer = r)));
    render(StatusBar, { props: { sessionId: "s9" } });
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Loading metrics…");
    answer(linux);
    expect(await screen.findByTestId("bar-cpu")).toBeInTheDocument();
    expect(screen.queryByTestId("bar-loading")).toBeNull();
  });

  it("says so when the host never answered", async () => {
    fetchMetrics.mockRejectedValue(new Error("no session"));
    render(StatusBar, { props: { sessionId: "s1" } });
    expect(await screen.findByText("Metrics unavailable")).toBeInTheDocument();
  });

  it("dims the last reading and names its age when the host stops answering", async () => {
    vi.useFakeTimers();
    fetchMetrics.mockResolvedValueOnce(linux).mockRejectedValue(new Error("down"));
    render(StatusBar, { props: { sessionId: "s2" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("bar-stale")).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    const mark = screen.getByTestId("bar-stale");
    expect(mark).toHaveTextContent("5s");
    expect(screen.getByTestId("bar-cpu").closest("[data-group]")?.parentElement).toHaveClass("opacity-50");
    // The numbers are still there: kept, not replaced by dashes.
    expect(groupText("cpu")).toBe("42%");
    vi.useRealTimers();
  });

  it("switching tabs shows the other session's last reading at once", async () => {
    fetchMetrics.mockResolvedValue(linux);
    const { rerender } = render(StatusBar, { props: { sessionId: "x1" } });
    await screen.findByTestId("bar-cpu");
    // The second tab: a host that has not answered yet.
    fetchMetrics.mockReturnValue(new Promise(() => {}));
    await rerender({ sessionId: "x2" });
    expect(screen.queryByTestId("bar-cpu")).toBeNull();
    // Back to the first: no "loading" — its reading is there before any answer.
    await rerender({ sessionId: "x1" });
    expect(groupText("cpu")).toBe("42%");
  });

  it("renders dashes where the host reported nothing", async () => {
    const sparse = {
      ...linux,
      os: "",
      prettyName: "",
      cpuPct: null,
      memUsed: null,
      memTotal: null,
      diskUsed: null,
      diskTotal: null,
      netTxRate: null,
      netRxRate: 1,
    } as Metrics;
    fetchMetrics.mockResolvedValue(sparse);
    render(StatusBar, { props: { sessionId: "s3" } });
    const os = await screen.findByTestId("bar-os");
    vi.useFakeTimers();
    await fireEvent.mouseEnter(os);
    vi.advanceTimersByTime(550);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Unknown OS");
    vi.useRealTimers();
    expect(groupText("cpu")).toBe("—");
    expect(groupText("ram")).toBe("—");
  });
});

describe("StatusBar — transfers", () => {
  it("shows the SFTP transfer indicator from the shared store, pinned outside the row", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s4" } });
    await screen.findByTestId("bar-cpu");
    expect(screen.queryByTestId("transfer-indicator")).toBeNull();
    applyProgress({ id: "x", name: "f.txt", direction: "upload", transferred: 1, total: 2, done: false });
    const ind = await screen.findByTestId("transfer-indicator");
    expect(ind.closest("[data-group]")).toBeNull();
    expect(ind).toHaveTextContent("50%");
  });

  it("clicking the indicator brings the file panel on screen, wherever it is docked", async () => {
    layout.docks.right.collapsed = true;
    layout.docks.right.active = "git";
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s5" } });
    await screen.findByTestId("bar-cpu");
    applyProgress({ id: "y", name: "f", direction: "download", transferred: 1, total: 4, done: false });
    await userEvent.click(await screen.findByTestId("transfer-indicator"));
    expect(layout.docks.right.collapsed).toBe(false);
    expect(layout.docks.right.active).toBe("files");
  });

  it("cancels every in-flight transfer, but not a sync run's files", async () => {
    sftpCancel.mockClear();
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s6" } });
    await screen.findByTestId("bar-cpu");
    const base = { name: "f", direction: "download" as const, total: 4 };
    applyProgress({ ...base, id: "dl-1", transferred: 1, done: false });
    applyProgress({ ...base, id: "sync:a/b.txt", transferred: 1, done: false });
    applyProgress({ ...base, id: "dl-2", transferred: 4, done: true });
    await userEvent.click(await screen.findByTestId("transfer-cancel-all"));
    expect(sftpCancel.mock.calls).toEqual([["dl-1"]]);
  });

  it("offers no cancel-all when only a sync run is transferring", async () => {
    fetchMetrics.mockResolvedValue(linux);
    render(StatusBar, { props: { sessionId: "s7" } });
    await screen.findByTestId("bar-cpu");
    applyProgress({ id: "sync:c.txt", name: "c.txt", direction: "upload", transferred: 1, total: 2, done: false });
    expect(await screen.findByTestId("transfer-indicator")).toBeInTheDocument();
    expect(screen.queryByTestId("transfer-cancel-all")).toBeNull();
  });
});
