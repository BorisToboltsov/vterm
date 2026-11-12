import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Chart from "./Chart.svelte";
import { DOT_REACH, type Sample } from "./chartgeom";

const smp = (vals: (number | null)[], from = 0): Sample[] => vals.map((v, i) => ({ s: from + i, v }));

// jsdom lays nothing out: give every element a width, as the window would.
let restoreWidth: () => void;
beforeEach(() => {
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 305 });
  restoreWidth = () => desc && Object.defineProperty(HTMLElement.prototype, "clientWidth", desc);
});
afterEach(() => restoreWidth());

describe("Chart", () => {
  it("draws nothing before the first sample", () => {
    const { container } = render(Chart, { props: { lines: [{ samples: [], color: "red" }], seq: -1 } });
    expect(container.querySelectorAll("path").length).toBe(0);
  });

  it("draws a line with its newest point at the right edge, not spread over the width", () => {
    const { container } = render(Chart, {
      props: { lines: [{ samples: smp([10, 20, 30]), color: "red" }], seq: 2, max: 100, slots: 11 },
    });
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBe(1);
    // 305 px wide minus a 5 px margin: the edge is at 300, a step is 30.
    expect(paths[0].getAttribute("d")).toMatch(/^M240,/);
    const dot = container.querySelector("circle")!;
    expect(dot.getAttribute("cx")).toBe("300");
  });

  it("adds an area under a filled line and breaks the line where a value was not read", () => {
    const { container } = render(Chart, {
      props: { lines: [{ samples: smp([1, 2, null, 4, 5]), color: "red", fill: true }], seq: 4, max: 10 },
    });
    // Two runs, each with its area.
    expect(container.querySelectorAll("path").length).toBe(4);
  });

  it("names an automatic ceiling, rounded", () => {
    const { container } = render(Chart, {
      props: {
        lines: [{ samples: smp([1.2e6, 3.4e6]), color: "red" }],
        seq: 1,
        scaleLabel: true,
        format: (v: number) => `${v / 1e6}M`,
      },
    });
    expect(container.textContent).toContain("5M");
  });

  it("keeps a line at its ceiling under the scale's name, not through it", () => {
    const { container } = render(Chart, {
      props: {
        lines: [{ samples: smp([480, 495, 500]), color: "red", fill: true }],
        seq: 2,
        scaleLabel: true,
        format: (v: number) => `${v}%`,
        height: 40,
      },
    });
    const label = [...container.querySelectorAll("text")].find((x) => x.textContent === "500%")!;
    const dot = container.querySelector("circle")!;
    // The number's baseline is above the highest the line — and its marker — can go.
    expect(Number(label.getAttribute("y"))).toBeLessThan(Number(dot.getAttribute("cy")) - DOT_REACH);
  });

  it("stacks layers into bands with the total on top", () => {
    const { container } = render(Chart, {
      props: {
        lines: [
          { samples: smp([10, 20]), color: "red" },
          { samples: smp([5, 5]), color: "blue" },
        ],
        seq: 1,
        max: 100,
        stacked: true,
      },
    });
    // One band per layer and one total line.
    expect(container.querySelectorAll("path").length).toBe(3);
  });

  it("leaves the total line out when the layers always fill the ceiling", () => {
    const { container } = render(Chart, {
      props: {
        lines: [
          { samples: smp([6, 7]), color: "red" },
          { samples: smp([10, 9]), color: "blue" },
        ],
        seq: 1,
        max: 16,
        stacked: true,
        total: false,
      },
    });
    expect(container.querySelectorAll("path").length).toBe(2);
    expect(container.querySelector("circle")).toBeNull();
  });

  it("marks the time under the chart and a threshold on it", () => {
    const { container } = render(Chart, {
      props: {
        lines: [{ samples: smp([10]), color: "red" }],
        seq: 0,
        max: 100,
        marks: true,
        interval: 5,
        threshold: 80,
        thresholdLabel: "80%",
      },
    });
    expect(container.textContent).toContain("−10:00");
    expect(container.textContent).toContain("80%");
  });

  it("shades zones behind the lines, cut at the ceiling, and none above it", () => {
    const { container } = render(Chart, {
      props: {
        lines: [{ samples: smp([0.4, 1.6]), color: "red" }],
        seq: 1,
        zones: [
          { from: 0.7, to: 1, color: "var(--color-warn)" },
          { from: 1, color: "var(--color-bad)" },
          { from: 5, color: "blue" },
        ],
      },
    });
    const zones = [...container.querySelectorAll("rect[data-zone]")];
    // The window reaches 1.6 — a ceiling of 2: two zones on it, the third above it.
    expect(zones.map((z) => z.getAttribute("data-zone"))).toEqual(["0", "1"]);
    expect(zones[1].getAttribute("style")).toContain("var(--color-bad)");
  });

  it("dashes a line asked to be dashed", () => {
    const { container } = render(Chart, {
      props: { lines: [{ samples: smp([1, 2]), color: "red", dashed: true }], seq: 1, max: 4 },
    });
    expect(container.querySelector("path")!.getAttribute("stroke-dasharray")).toBe("3 3");
  });
});
