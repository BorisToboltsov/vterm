import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Metrics } from "../api";

const fetchMetrics = vi.fn();
vi.mock("../api", () => ({
  fetchMetrics: (...a: unknown[]) => fetchMetrics(...a),
}));

import { feedOf, forgetMetrics, metricsFeed, pollEveryMs, readMetrics, watchMetrics } from "./metricsfeed.svelte";
import { resetSettings, settings } from "../settings/settings.svelte";

const reading = (cpu: number): Metrics =>
  ({
    os: "Linux",
    prettyName: "",
    hostname: "h",
    user: "u",
    load1: 0.1,
    load5: 0.1,
    load15: 0.1,
    cpuPct: cpu,
    memUsed: 1,
    memTotal: 4,
    diskUsed: 1,
    diskTotal: 2,
    netTxRate: 10,
    netRxRate: 20,
    diskReadRate: null,
    diskWriteRate: null,
    uptimeSecs: 1,
    swapUsed: null,
    swapTotal: null,
    users: "",
    ip: "",
    topProc: "",
    cpuTemp: null,
    netConns: null,
    kernel: "",
    serverTime: "",
    cpuCount: 2,
  }) as Metrics;

// Let the awaited probe settle without moving the clock.
const settle = () => vi.advanceTimersByTimeAsync(0);

const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
beforeEach(() => {
  vi.useFakeTimers();
  resetSettings();
  settings.statusPollInterval = 5;
  fetchMetrics.mockReset();
  for (const id of ids) forgetMetrics(id);
});
afterEach(() => {
  for (const id of ids) forgetMetrics(id);
  vi.useRealTimers();
});

describe("metrics feed", () => {
  it("polls once at the first watcher, then on the beat — one probe for every watcher", async () => {
    fetchMetrics.mockResolvedValue(reading(10));
    const stopBar = watchMetrics("a");
    const stopCard = watchMetrics("a");
    await settle();
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    expect(feedOf("a")).toMatchObject({ seq: 0, failedAt: null });
    expect(feedOf("a").metrics?.cpuPct).toBe(10);

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMetrics).toHaveBeenCalledTimes(2);
    expect(feedOf("a").seq).toBe(1);
    expect(feedOf("a").hist.cpu.map((x) => x.v)).toEqual([10, 10]);
    stopBar();
    stopCard();
  });

  it("stops when the last watcher leaves, and keeps the reading for the next one", async () => {
    fetchMetrics.mockResolvedValue(reading(10));
    const stop = watchMetrics("b");
    await settle();
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    // The tab comes back: the last reading is there at once, then a fresh poll.
    expect(feedOf("b").metrics?.cpuPct).toBe(10);
    fetchMetrics.mockResolvedValue(reading(30));
    const again = watchMetrics("b");
    await settle();
    expect(feedOf("b").metrics?.cpuPct).toBe(30);
    again();
  });

  it("keeps the last reading when a poll fails, marks when, and leaves a gap in the history", async () => {
    fetchMetrics.mockResolvedValueOnce(reading(10)).mockRejectedValueOnce(new Error("down"));
    const stop = watchMetrics("c");
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    const f = feedOf("c");
    expect(f.metrics?.cpuPct).toBe(10);
    expect(f.failedAt).not.toBeNull();
    expect(f.hist.cpu.map((x) => x.v)).toEqual([10, null]);
    // A poll that comes back clears the mark.
    fetchMetrics.mockResolvedValue(reading(20));
    await vi.advanceTimersByTimeAsync(5000);
    expect(feedOf("c").failedAt).toBeNull();
    stop();
  });

  it("runs a companion in the same tick, numbered as the poll", async () => {
    fetchMetrics.mockResolvedValue(reading(10));
    const companion = vi.fn(async () => "detail");
    const done = vi.fn();
    const stop = watchMetrics("d", { companion, done });
    await settle();
    expect(companion).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenLastCalledWith(expect.objectContaining({ cpuPct: 10 }), "detail", 0);
    // With a companion aboard the beat is never under 2 s.
    settings.statusPollInterval = 1;
    expect(pollEveryMs(true)).toBe(2000);
    expect(pollEveryMs(false)).toBe(1000);
    stop();
  });

  it("answers a companion joining a running loop at once, off the beat", async () => {
    fetchMetrics.mockResolvedValue(reading(10));
    const stopBar = watchMetrics("e");
    await settle();
    const done = vi.fn();
    const stopPage = watchMetrics("e", { companion: async () => "detail", done });
    await settle();
    // Not a new poll of the basic probe, and not a sample: −1.
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenLastCalledWith(expect.objectContaining({ cpuPct: 10 }), "detail", -1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toHaveBeenLastCalledWith(expect.anything(), "detail", 1);
    stopBar();
    stopPage();
  });

  it("tells a watcher of a failed companion with null, and the poll goes on", async () => {
    fetchMetrics.mockResolvedValue(reading(10));
    const done = vi.fn();
    const stop = watchMetrics("f", { companion: async () => Promise.reject(new Error("x")), done });
    await settle();
    expect(done).toHaveBeenLastCalledWith(expect.objectContaining({ cpuPct: 10 }), null, 0);
    expect(feedOf("f").failedAt).toBeNull();
    stop();
  });

  it("skips the probe while the window is hidden, and keeps the beat", async () => {
    fetchMetrics.mockResolvedValue(reading(10));
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const stop = watchMetrics("g");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMetrics).not.toHaveBeenCalled();
    vis.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    vis.mockRestore();
    stop();
  });

  it("drops the feed and stops the loop when the tab goes", async () => {
    fetchMetrics.mockResolvedValue(reading(10));
    watchMetrics("h");
    await settle();
    forgetMetrics("h");
    expect("h" in metricsFeed.by).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    expect(feedOf("h").metrics).toBeNull();
  });

  it("does not bring back a feed whose answer lands after the tab went", async () => {
    let answer: (m: Metrics) => void = () => {};
    fetchMetrics.mockReturnValue(new Promise<Metrics>((r) => (answer = r)));
    watchMetrics("i");
    forgetMetrics("i");
    answer(reading(10));
    await settle();
    expect("i" in metricsFeed.by).toBe(false);
  });

  it("answers a one-off question from a fresh reading, else asks — without a sample", async () => {
    fetchMetrics.mockResolvedValue(reading(10));
    expect((await readMetrics("j")).cpuPct).toBe(10);
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    expect(feedOf("j").seq).toBe(-1);
    // Fresh: no second probe.
    expect((await readMetrics("j")).cpuPct).toBe(10);
    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    // Older than a beat: asked again.
    vi.advanceTimersByTime(6000);
    fetchMetrics.mockResolvedValue(reading(40));
    expect((await readMetrics("j")).cpuPct).toBe(40);
    expect(fetchMetrics).toHaveBeenCalledTimes(2);
  });
});
