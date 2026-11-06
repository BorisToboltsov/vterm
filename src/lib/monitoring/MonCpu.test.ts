import { render, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Metrics } from "../api";
import { resetSettings, settings } from "../settings/settings.svelte";
import MonCpu from "./MonCpu.svelte";
import { pushReadings, type History } from "./monhistory";
import { problems, sectionLevels } from "./monproblems";
import type { MonView } from "./monsections";

// jsdom lays nothing out: give every element a width, as the window would.
let restoreWidth: () => void;
beforeEach(() => {
  resetSettings();
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 305 });
  restoreWidth = () => desc && Object.defineProperty(HTMLElement.prototype, "clientWidth", desc);
});
afterEach(() => restoreWidth());

// One thread, load now 0.75; a minute ago it was 1.6.
const metrics = { os: "Linux", cpuPct: 32, load1: 0.75, load5: 0.77, load15: 0.44, cpuCount: 1 } as Metrics;

function view(hist: History, seq: number): MonView {
  const th = settings.statusBarThresholds;
  const ps = problems({ metrics, detail: null, extras: null, pending: null, th, baseline: null });
  return {
    sessionId: "s1",
    metrics,
    detail: null,
    extras: null,
    live: null,
    pending: null,
    pendingLoading: false,
    hist,
    seq,
    interval: 5,
    th,
    problems: ps,
    levels: sectionLevels(ps),
    loadingDelta: false,
    baseline: null,
  };
}

describe("MonCpu — the load chart", () => {
  it("scales to the window, so an earlier peak is not cut at the ceiling", () => {
    let h: History = {};
    [1.6, 1.2, 0.75].forEach((v, s) => (h = pushReadings(h, s, { load1: v, load5: 0.77, load15: 0.44 })));
    const { getByTestId } = render(MonCpu, { props: { v: view(h, 2), a: { go: () => {} } } });
    const chart = getByTestId("load-history");
    // The ceiling is 2 — not 1, the round-up of the newest 0.75 that clipped the 1.6.
    expect(within(chart).getByText("2")).toBeInTheDocument();
    expect(within(chart).getByText("1")).toBeInTheDocument();
  });

  it("shades where load turns warn and crit, behind three told-apart lines", () => {
    let h: History = {};
    [0.4, 0.75].forEach((v, s) => (h = pushReadings(h, s, { load1: v, load5: 0.5, load15: 0.3 })));
    const { getByTestId } = render(MonCpu, { props: { v: view(h, 1), a: { go: () => {} } } });
    const chart = getByTestId("load-history");
    const zones = [...chart.querySelectorAll("rect[data-zone]")];
    // On a ceiling of 1 the warn zone (0.7–1) shows; the crit one starts at the ceiling.
    expect(zones).toHaveLength(1);
    expect(zones[0].getAttribute("style")).toContain("var(--color-warn)");
    // Three lines in three colours, none of them a dashed threshold line over the data.
    const strokes = [...chart.querySelectorAll("path[fill='none']")].map((p) => p.getAttribute("style"));
    expect(new Set(strokes).size).toBe(3);
    expect(chart.querySelectorAll("line[stroke='var(--color-warn)']")).toHaveLength(0);
    expect(getByTestId("load-card")).toHaveTextContent("per thread 0.75");
  });

  it("lays no thread grid for one thread — its one tile would be the CPU chart again", () => {
    let h: History = {};
    [0.4, 0.75].forEach((v, s) => (h = pushReadings(h, s, { load1: v, "core.0": 30 })));
    const { queryByTestId, getByTestId } = render(MonCpu, {
      props: { v: { ...view(h, 1), loadingDelta: true }, a: { go: () => {} } },
    });
    expect(queryByTestId("per-core")).toBeNull();
    expect(queryByTestId("per-core-skeleton")).toBeNull();
    // Two figures known so far, two columns — no empty cells beside them.
    expect(getByTestId("cpu-queues").querySelector("dl")!.getAttribute("style")).toContain("repeat(2,");
  });
});
