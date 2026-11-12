import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Extras, LiveExtras, Metrics, MetricsDetail, PendingUpdates, ProcessDetail } from "../api";

const fetchMetrics = vi.fn();
const fetchMetricsDetail = vi.fn();
const fetchPendingUpdates = vi.fn();
const fetchExtras = vi.fn();
const fetchLiveExtras = vi.fn();
const fetchProcessDetail = vi.fn();
vi.mock("../api", () => ({
  fetchMetrics: (...a: unknown[]) => fetchMetrics(...a),
  fetchMetricsDetail: (...a: unknown[]) => fetchMetricsDetail(...a),
  fetchPendingUpdates: (...a: unknown[]) => fetchPendingUpdates(...a),
  fetchExtras: (...a: unknown[]) => fetchExtras(...a),
  fetchLiveExtras: (...a: unknown[]) => fetchLiveExtras(...a),
  fetchProcessDetail: (...a: unknown[]) => fetchProcessDetail(...a),
}));

import MonitoringOverlay from "./MonitoringOverlay.svelte";
import { resetSettings } from "../settings/settings.svelte";
import { feedOf, forgetMetrics, watchMetrics } from "../stores/metricsfeed.svelte";

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
  cpuCount: 4,
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
    { mount: "/", fstype: "ext4", used: 87, total: 100, inodesUsed: 123456, inodesTotal: 655360 },
    { mount: "/boot", fstype: "vfat", used: 1, total: 10, inodesUsed: null, inodesTotal: null },
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
  diskDevs: [{ name: "sda", readRate: 4096, writeRate: 8192, utilPct: 42, awaitMs: 3.5 }],
  sessions: [{ user: "root", tty: "pts/0", from: "192.168.1.50", login: "2026-06-29 14:00" }],
  ctxtRate: 5000,
  intrRate: 3000,
  procsRunning: 2,
  procsBlocked: 0,
  failedUnitNames: ["nginx.service"],
  swapInRate: null,
  swapOutRate: null,
  cpuFreqMhz: [2400, 2400, 1200, 800],
  throttleCount: 0,
  listenSockets: [
    { proto: "tcp", addr: "0.0.0.0", port: 22, process: "sshd", pid: 812 },
    { proto: "tcp", addr: "::", port: 443, process: null, pid: null },
  ],
  processes: [],
  processTotal: 3,
};

const row = (pid: number, ppid: number, comm: string, cpu: number | null, user = "root") => ({
  pid,
  ppid,
  user,
  state: "sleeping" as const,
  elapsedSecs: 7200,
  threads: 2,
  rss: 50 * 1024 ** 2,
  mem: 1.5,
  cpu,
  comm,
});
const PROCESSES = [row(1, 0, "systemd", 0.1), row(1234, 1, "nginx", 12.5), row(1300, 1234, "nginx-worker", 3, "www")];

const pending: PendingUpdates = { manager: "apt", updates: 12, security: 3, rebootRequired: true };

const docker = [{ name: "web", cpu: 12.5, mem: "1.2GiB / 3.8GiB", memUsed: 1288490188, memLimit: null, cpuLimit: null }];

const extras: Extras = {
  gpus: [],
  docker,
  smart: [{ device: "sda", health: "PASSED", temp: 38, powerOnHours: 12345, wearPct: 3, reallocated: 0 }],
  oomKills: 2,
  oomVictims: [{ pid: 99, name: "postgres", at: "2026-11-05T09:14:22+0000", bootSecs: null }],
  logins: [{ user: "deploy", tty: "pts/0", from: "10.0.0.12", at: "2026-11-05T09:14:22+00:00", active: true }],
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

const live: LiveExtras = { gpus: [], docker };

beforeEach(() => {
  resetSettings();
  fetchMetrics.mockReset().mockResolvedValue(metrics);
  fetchMetricsDetail.mockReset().mockResolvedValue(detail);
  fetchPendingUpdates.mockReset().mockResolvedValue(pending);
  fetchExtras.mockReset().mockResolvedValue(extras);
  fetchLiveExtras.mockReset().mockResolvedValue(live);
  fetchProcessDetail.mockReset();
  // The session's feed outlives a component: each test starts without one.
  forgetMetrics("s1");
});

async function openOn(section?: string, props: Record<string, unknown> = {}) {
  render(MonitoringOverlay, { props: { open: true, sessionId: "s1", ...props } });
  await screen.findByTestId("mon-nav");
  if (section) await fireEvent.click(screen.getByTestId(`mon-nav-${section}`));
  return section ? screen.findByTestId(`mon-section-${section}`) : screen.getByTestId("mon-section-overview");
}

describe("MonitoringOverlay — the session's feed", () => {
  it("opens on the section it is given", async () => {
    render(MonitoringOverlay, { props: { open: true, sessionId: "s1", section: "memory" } });
    expect(await screen.findByTestId("mon-section-memory")).toBeInTheDocument();
    expect(screen.getByTestId("mon-nav-memory")).toHaveAttribute("aria-current", "page");
  });

  it("rides the feed the status bar already runs: one basic probe, the history it kept", async () => {
    // The bar has been watching: its poll is in the feed.
    const stopBar = watchMetrics("s1");
    await vi.waitFor(() => expect(feedOf("s1").seq).toBe(0));
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    render(MonitoringOverlay, { props: { open: true, sessionId: "s1" } });
    await screen.findByTestId("mon-nav");
    // Opening fetched the detail at once — not a second basic probe.
    await vi.waitFor(() => expect(fetchMetricsDetail).toHaveBeenCalledTimes(1));
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    stopBar();
  });
});

describe("MonitoringOverlay — navigation and overview", () => {
  it("opens on the overview and offers only the sections this host has", async () => {
    await openOn();
    const nav = screen.getByTestId("mon-nav");
    for (const s of ["overview", "cpu", "memory", "disks", "network", "temperature", "processes", "system"]) {
      expect(within(nav).getByTestId(`mon-nav-${s}`)).toBeInTheDocument();
    }
    // No GPU on this host — no GPU section. Containers appear once the extras arrive.
    expect(within(nav).queryByTestId("mon-nav-gpu")).toBeNull();
    expect(await within(nav).findByTestId("mon-nav-containers")).toBeInTheDocument();
    expect(within(nav).getByTestId("mon-nav-cpu")).toHaveTextContent("42%");
  });

  it("lists what needs attention, the critical first, and colours the navigation by it", async () => {
    await openOn();
    // The failed unit (crit) shows at once; the pending and extras problems once they load.
    const list = await screen.findByTestId("mon-problems");
    await within(list).findByText("Security updates waiting: 3");
    const rows = within(list).getAllByTestId("mon-problem");
    expect(rows[0]).toHaveAttribute("data-level", "crit");
    expect(within(list).getByText("nginx.service")).toBeInTheDocument();
    expect(within(list).getByText("/ is 87% full (0 MiB of 0 MiB)")).toBeInTheDocument();
    expect(screen.getByTestId("mon-nav-system")).toHaveAttribute("data-level", "crit");
    expect(screen.getByTestId("mon-nav-disks")).toHaveAttribute("data-level", "warn");
    expect(screen.getByTestId("mon-overall")).toHaveAttribute("data-level", "crit");
  });

  it("goes to a problem's section from its row", async () => {
    await openOn();
    const list = await screen.findByTestId("mon-problems");
    const row = within(list).getByText("/ is 87% full (0 MiB of 0 MiB)").closest("li")!;
    await fireEvent.click(within(row).getByText("Disks"));
    expect(await screen.findByTestId("mon-section-disks")).toBeInTheDocument();
  });

  it("says so when nothing needs attention", async () => {
    fetchMetricsDetail.mockResolvedValue({ ...detail, failedUnits: 0, failedUnitNames: [], partitions: [] });
    fetchPendingUpdates.mockResolvedValue({ ...pending, security: 0, rebootRequired: false });
    fetchExtras.mockResolvedValue({ ...extras, oomKills: 0 });
    await openOn();
    expect(await screen.findByTestId("mon-all-clear")).toBeInTheDocument();
  });

  it("hands the snapshot, its problems and the question's subject to the assistant, and closes", async () => {
    const onAskAi = vi.fn();
    await openOn(undefined, { onAskAi });
    await screen.findByText("Security updates waiting: 3");
    await fireEvent.click(screen.getAllByTestId("mon-ask-ai")[0]);
    const snapshot = onAskAi.mock.calls[0][0] as string;
    expect(snapshot).toContain("Question about: the overall state of this host");
    expect(snapshot).toContain("Needs attention:");
    expect(snapshot).toContain("- [crit] Failed systemd units: 1 (nginx.service)");
    expect(screen.queryByTestId("mon-nav")).toBeNull();
  });

  it("offers no assistant without the callback (AI off or the panel hidden)", async () => {
    await openOn();
    expect(screen.queryByTestId("mon-ask-ai")).toBeNull();
  });

  it("does not poll while closed", () => {
    render(MonitoringOverlay, { props: { open: false, sessionId: "s1" } });
    expect(fetchMetrics).not.toHaveBeenCalled();
    expect(fetchMetricsDetail).not.toHaveBeenCalled();
    expect(fetchLiveExtras).not.toHaveBeenCalled();
  });
});

describe("MonitoringOverlay — sections", () => {
  it("CPU: history, threads with their frequency, queues, and the heaviest processes", async () => {
    const sec = await openOn("cpu");
    expect(within(sec).getByTestId("cpu-history")).toBeInTheDocument();
    expect(within(sec).getByTestId("load-history")).toBeInTheDocument();
    // Four threads — one even row of four, not four of eight columns.
    expect(within(sec).getByTestId("per-core").getAttribute("style")).toContain("repeat(4,");
    expect(within(sec).getAllByText("2.40 GHz")).toHaveLength(2);
    // Queues and events across the width: seven figures — rows of four and three, not five and two.
    const queues = within(sec).getByTestId("cpu-queues");
    expect(queues.querySelectorAll("[data-testid^='fact-']")).toHaveLength(7);
    expect(queues.querySelector("dl")!.getAttribute("style")).toContain("repeat(4,");
    expect(within(queues).getByTestId("fact-psi")).toHaveTextContent("1.5 / 0.2 / 0.1");
    expect(within(queues).getByTestId("fact-freq")).toHaveTextContent("800 MHz – 2.40 GHz");
    expect(within(sec).getByTestId("top-procs")).toHaveTextContent("nginx");
  });

  it("CPU: names the problem behind its dot under the head and marks where it shows", async () => {
    // 3.2 on 4 threads — 0.8 per thread, past the 0.7 warning.
    fetchMetrics.mockResolvedValue({ ...metrics, load1: 3.2 });
    const sec = await openOn("cpu");
    expect(screen.getByTestId("mon-nav-cpu")).toHaveAttribute("data-level", "warn");
    const strip = within(sec).getByTestId("mon-section-problems");
    expect(within(strip).getAllByTestId("mon-problem")).toHaveLength(1);
    expect(strip).toHaveTextContent("Load 3.20 has reached 2.8 · threads: 4");
    expect(within(sec).getByTestId("load-card")).toHaveClass("border-warn/50");
    expect(within(sec).getByTestId("load-per-thread")).toHaveAttribute("data-level", "warn");
    expect(within(sec).getByTestId("load-card")).toHaveTextContent("per thread 0.80 threshold 0.7");
    expect(within(sec).getByTestId("load-legend")).toHaveTextContent("warning from 2.8");
    expect(within(sec).getByTestId("load-legend")).toHaveTextContent("critical from 4");
  });

  it("CPU: nothing under the head and nothing marked when CPU is fine", async () => {
    const sec = await openOn("cpu");
    expect(screen.getByTestId("mon-nav-cpu")).toHaveAttribute("data-level", "ok");
    expect(within(sec).queryByTestId("mon-section-problems")).toBeNull();
    expect(within(sec).getByTestId("load-card")).toHaveClass("border-edge");
    expect(within(sec).getByTestId("load-card")).not.toHaveTextContent("threshold");
  });

  it("a section lists its own problems under its head, and the overview none twice", async () => {
    const disks = await openOn("disks");
    const strip = within(disks).getByTestId("mon-section-problems");
    expect(strip).toHaveTextContent("/ is 87% full (0 MiB of 0 MiB)");
    expect(strip).not.toHaveTextContent("Failed systemd units");
    await fireEvent.click(screen.getByTestId("mon-nav-overview"));
    const overview = await screen.findByTestId("mon-section-overview");
    expect(within(overview).queryByTestId("mon-section-problems")).toBeNull();
  });

  it("asks the assistant about a problem from a section's strip", async () => {
    const onAskAi = vi.fn();
    const sec = await openOn("system", { onAskAi });
    const strip = within(sec).getByTestId("mon-section-problems");
    const row = within(strip).getByText("Failed systemd units: 1").closest("li")!;
    await fireEvent.click(within(row).getByRole("button", { name: "Ask AI" }));
    expect(onAskAi.mock.calls[0][0]).toContain("Failed systemd units: 1");
  });

  it("CPU: hides the load card on a host with no load average (Windows)", async () => {
    fetchMetrics.mockResolvedValue({ ...metrics, os: "Windows", load1: null, load5: null, load15: null });
    const sec = await openOn("cpu");
    expect(within(sec).queryByTestId("load-history")).toBeNull();
  });

  it("Memory: composition, OOM victims and the heaviest by memory", async () => {
    const sec = await openOn("memory");
    expect(within(sec).getByTestId("mem-composition")).toBeInTheDocument();
    expect(within(sec).getByTestId("top-mem")).toHaveTextContent("redis-server");
    expect(await within(sec).findByText("postgres (99)")).toBeInTheDocument();
  });

  it("Memory: says OOM kills are unknown when the kernel log could not be read", async () => {
    fetchExtras.mockResolvedValue({ ...extras, oomKills: null, oomVictims: [] });
    const sec = await openOn("memory");
    expect(await within(sec).findByText(/OOM kills are unknown/)).toBeInTheDocument();
  });

  it("Disks: fullest first, coloured by the threshold, with devices and SMART", async () => {
    const sec = await openOn("disks");
    const parts = within(sec).getByTestId("partitions");
    const rows = parts.querySelectorAll("tbody tr");
    expect(rows[0]).toHaveTextContent("/");
    expect(within(parts).getByText("87%")).toHaveClass("text-warn");
    expect(within(sec).getByTestId("disk-devs")).toHaveTextContent("3.5 ms");
    expect(await within(sec).findByText("PASSED")).toBeInTheDocument();
  });

  it("Network: a long interface name truncates with a tooltip, TCP and listeners are listed", async () => {
    const longName = "Ethernet-Kaspersky Lab NDIS 6 Filter-0000";
    fetchMetricsDetail.mockResolvedValue({
      ...detail,
      netIfaces: [{ name: longName, rxRate: 2764, txRate: 515, rxErrs: 0, rxDrop: 0, txErrs: 0, txDrop: 0 }],
    });
    const sec = await openOn("network");
    const wrap = within(sec).getByTestId("net-ifaces");
    expect(wrap.querySelector("table")).toHaveClass("table-fixed");
    expect(within(wrap).getByText(longName)).toHaveClass("truncate");
    expect(within(sec).getByTestId("tcp-states")).toHaveTextContent("ESTAB");
    const listen = within(sec).getByTestId("listen-sockets");
    expect(listen).toHaveTextContent("sshd (812)");
    expect(within(sec).getByTestId("sessions")).toHaveTextContent("192.168.1.50");
  });

  it("Temperature: a core heat grid and every sensor against its limits", async () => {
    const sec = await openOn("temperature");
    expect(within(sec).getByTestId("core-temps")).toBeInTheDocument();
    expect(within(sec).getByTestId("sensors-table")).toHaveTextContent("Package id 0");
  });

  it("Temperature: offers to install lm-sensors when it is missing", async () => {
    const onInstallTool = vi.fn();
    fetchMetrics.mockResolvedValue({ ...metrics, cpuTemp: null });
    fetchMetricsDetail.mockResolvedValue({ ...detail, sensors: [], sensorsInstalled: false });
    const sec = await openOn("temperature", { onInstallTool });
    await fireEvent.click(within(within(sec).getByTestId("sensors-install")).getByText("Install lm-sensors"));
    expect(onInstallTool).toHaveBeenCalledWith("sensors");
  });

  it("Temperature: a host with lm-sensors but no chips gets a note, not the install offer", async () => {
    fetchMetrics.mockResolvedValue({ ...metrics, cpuTemp: null });
    fetchMetricsDetail.mockResolvedValue({ ...detail, sensors: [], sensorsInstalled: true });
    const sec = await openOn("temperature");
    expect(within(sec).getByTestId("sensors-none")).toBeInTheDocument();
    expect(within(sec).queryByTestId("sensors-install")).toBeNull();
  });

  it("Temperature: says it is unsupported on Windows", async () => {
    fetchMetrics.mockResolvedValue({ ...metrics, os: "Windows", cpuTemp: null });
    fetchMetricsDetail.mockResolvedValue({ ...detail, sensors: [], sensorsInstalled: false });
    const sec = await openOn("temperature");
    expect(within(sec).getByTestId("sensors-unsupported")).toBeInTheDocument();
  });

  it("Processes: asks for every process only while the section is on screen", async () => {
    fetchMetricsDetail.mockImplementation((_id: string, all?: boolean) =>
      Promise.resolve({ ...detail, processes: all ? PROCESSES : [] }),
    );
    await openOn();
    expect(fetchMetricsDetail.mock.calls.every((c) => !c[1])).toBe(true);
    await fireEvent.click(screen.getByTestId("mon-nav-processes"));
    const sec = await screen.findByTestId("mon-section-processes");
    expect(fetchMetricsDetail).toHaveBeenCalledWith("s1", true);
    const rows = await within(sec).findAllByTestId("proc-row");
    // Busiest first.
    expect(rows.map((r) => r.textContent?.match(/^\d+/)?.[0])).toEqual(["1234", "1300", "1"]);
  });

  it("Processes: filters through the lists' row, and draws a tree by parent", async () => {
    fetchMetricsDetail.mockResolvedValue({ ...detail, processes: PROCESSES });
    const sec = await openOn("processes");
    await within(sec).findAllByTestId("proc-row");
    const field = within(within(sec).getByTestId("proc-list-header")).getByRole("textbox");
    await fireEvent.input(field, { target: { value: "worker" } });
    expect(within(sec).getAllByTestId("proc-row")).toHaveLength(1);
    await fireEvent.input(field, { target: { value: "" } });
    await fireEvent.click(within(sec).getByTestId("proc-list-header-view"));
    await fireEvent.click(await screen.findByText("As a tree"));
    const order = within(sec)
      .getAllByTestId("proc-row")
      .map((r) => r.textContent?.match(/^\d+/)?.[0]);
    expect(order).toEqual(["1", "1234", "1300"]);
  });

  it("Processes: shares View and Filters with the row menu, without requesting process details", async () => {
    fetchMetricsDetail.mockResolvedValue({ ...detail, processes: PROCESSES });
    const sec = await openOn("processes");
    const rows = await within(sec).findAllByTestId("proc-row");
    await fireEvent.contextMenu(rows[0]);
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "As a tree" }));
    expect(within(sec).getAllByTestId("proc-row").map((r) => r.textContent?.match(/^\d+/)?.[0])).toEqual(["1", "1234", "1300"]);
    expect(screen.queryByTestId("proc-detail")).toBeNull();
    const field = within(screen.getByTestId("proc-list-header")).getByRole("textbox");
    await fireEvent.input(field, { target: { value: "missing" } });
    await fireEvent.contextMenu(screen.getByTestId("proc-list-header"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Reset search and filters" }));
    expect(within(sec).getAllByTestId("proc-row")).toHaveLength(PROCESSES.length);
  });

  it("Processes: says CPU comes with the second reading and when the list is capped", async () => {
    fetchMetricsDetail.mockResolvedValue({
      ...detail,
      processes: PROCESSES.map((r) => ({ ...r, cpu: null })),
      processTotal: 5000,
    });
    const sec = await openOn("processes");
    const note = await within(sec).findByTestId("proc-note");
    expect(note).toHaveTextContent("CPU appears with the second reading");
    expect(note).toHaveTextContent(`showing the first 3 of ${(5000).toLocaleString()}`);
  });

  it("Processes: a click reads that process once and shows its command line", async () => {
    const d: ProcessDetail = {
      pid: 1234,
      user: "root",
      state: "sleeping",
      elapsedSecs: 7200,
      threads: 4,
      rss: 50 * 1024 ** 2,
      cmdline: "nginx: master process /usr/sbin/nginx",
      fds: null,
    };
    fetchMetricsDetail.mockResolvedValue({ ...detail, processes: PROCESSES });
    fetchProcessDetail.mockResolvedValue(d);
    const onRunInTerminal = vi.fn();
    const sec = await openOn("processes", { onRunInTerminal });
    await fireEvent.click((await within(sec).findAllByTestId("proc-row"))[0]);
    const card = await within(sec).findByTestId("proc-detail");
    expect(await within(card).findByText("nginx: master process /usr/sbin/nginx")).toBeInTheDocument();
    expect(fetchProcessDetail).toHaveBeenCalledTimes(1);
    expect(fetchProcessDetail).toHaveBeenCalledWith("s1", 1234);
    expect(within(card).getByText("sleeping")).toBeInTheDocument();
    expect(within(card).getByText("hidden from this user")).toBeInTheDocument();
    await fireEvent.click(within(card).getByText("top -p 1234 in the terminal"));
    expect(onRunInTerminal).toHaveBeenCalledWith(["top", "-p", "1234"]);
  });

  it("Processes: CPU is % of a core, its bar against every core; the picked one counts its cores", async () => {
    // jsdom lays nothing out: the chart draws once it has a width, as in the window.
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 305 });
    onTestFinished(() => {
      if (desc) Object.defineProperty(HTMLElement.prototype, "clientWidth", desc);
    });
    // 4 cores: 200 % is two of them — half the machine, not a full bar.
    const busy = [row(1, 0, "systemd", 0.1), row(1234, 1, "nginx", 200), row(1300, 1234, "nginx-worker", 3, "www")];
    fetchMetricsDetail.mockResolvedValue({ ...detail, processes: busy });
    fetchProcessDetail.mockResolvedValue(null);
    const sec = await openOn("processes");
    const rows = await within(sec).findAllByTestId("proc-row");
    expect(within(sec).getByText("CPU, % of a core")).toBeInTheDocument();
    const bar = (r: HTMLElement) => r.querySelector("[data-pct]")?.getAttribute("data-pct");
    expect(rows.map(bar)).toEqual(["50", "1", "0"]);
    await fireEvent.click(rows[0]);
    const card = await within(sec).findByTestId("proc-detail");
    expect(await within(card).findByTestId("proc-cores-busy")).toHaveTextContent("≈ 2.0 of 4 cores");
    // The chart's ceiling is every core busy, on the left — not a corner label under the line.
    expect(within(card).getByTestId("proc-cpu-chart")).toHaveTextContent("400%");
  });

  it("Processes: a process that has ended says so", async () => {
    fetchMetricsDetail.mockResolvedValue({ ...detail, processes: PROCESSES });
    fetchProcessDetail.mockResolvedValue(null);
    const sec = await openOn("processes");
    await fireEvent.click((await within(sec).findAllByTestId("proc-row"))[0]);
    expect(await within(sec).findByText("The process has ended.")).toBeInTheDocument();
  });

  it("Containers: polled live only while on screen, no share without a limit", async () => {
    const onOpenDocker = vi.fn();
    await openOn(undefined, { onOpenDocker });
    await screen.findByTestId("mon-nav-containers");
    expect(fetchLiveExtras).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId("mon-nav-containers"));
    const sec = await screen.findByTestId("mon-section-containers");
    expect(fetchLiveExtras).toHaveBeenCalledWith("s1");
    expect(within(sec).getByTestId("docker-list")).toHaveTextContent("no limit");
    await fireEvent.click(within(sec).getByText("Docker panel"));
    expect(onOpenDocker).toHaveBeenCalled();
  });

  it("GPU: appears when the host has one", async () => {
    const gpu = { name: "RTX 4090", util: 35, memUsed: 1024, memTotal: 24576, temp: 61, powerDraw: 120, powerLimit: 450, clockSm: 2100, clockMem: 10500, procs: [{ pid: 7, name: "python3", memMib: 900 }] };
    fetchExtras.mockResolvedValue({ ...extras, gpus: [gpu] });
    fetchLiveExtras.mockResolvedValue({ gpus: [gpu], docker });
    await openOn();
    await fireEvent.click(await screen.findByTestId("mon-nav-gpu"));
    const sec = await screen.findByTestId("mon-section-gpu");
    expect(within(sec).getByTestId("gpu-card")).toHaveTextContent("python3");
  });

  it("System: failed units by name, a read-only command for them, hardware and logins", async () => {
    const onRunInTerminal = vi.fn();
    const sec = await openOn("system", { onRunInTerminal });
    expect(within(sec).getByTestId("failed-units")).toHaveTextContent("nginx.service");
    expect(await within(sec).findByText("Intel Xeon E5-2680 v4")).toBeInTheDocument();
    expect(within(sec).getByTestId("logins")).toHaveTextContent("deploy");
    // The command goes to the terminal, and the page gets out of its way.
    await fireEvent.click(within(sec).getByText("systemctl --failed in the terminal"));
    expect(onRunInTerminal).toHaveBeenCalledWith(["systemctl", "--failed"]);
    expect(screen.queryByTestId("mon-nav")).toBeNull();
  });

  it("System: shows an update skeleton while the lazy probe runs, then the manager's list command", async () => {
    let resolve!: (p: PendingUpdates) => void;
    fetchPendingUpdates.mockReturnValue(new Promise<PendingUpdates>((r) => (resolve = r)));
    const onRunInTerminal = vi.fn();
    const sec = await openOn("system", { onRunInTerminal });
    expect(await within(sec).findByTestId("updates-skeleton")).toBeInTheDocument();
    resolve(pending);
    await fireEvent.click(await within(sec).findByText("apt list --upgradable in the terminal"));
    expect(onRunInTerminal).toHaveBeenCalledWith(["apt", "list", "--upgradable"]);
  });
});
