import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Chart from "./Chart.svelte";

describe("Chart", () => {
  it("draws a single line path for a series", () => {
    const { container } = render(Chart, {
      props: { series: [{ values: [1, 2, 3], color: "#f00" }] },
    });
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBe(1);
    expect(paths[0].getAttribute("d")).toMatch(/^M/);
    expect(paths[0].getAttribute("stroke")).toBe("#f00");
  });

  it("adds an area fill path when fill is set", () => {
    const { container } = render(Chart, {
      props: { series: [{ values: [1, 2, 3], color: "#0f0", fill: true }] },
    });
    // area (fill) + line
    expect(container.querySelectorAll("path").length).toBe(2);
  });

  it("renders one line per series for multi-series", () => {
    const { container } = render(Chart, {
      props: {
        series: [
          { values: [1, 2], color: "#1" },
          { values: [3, 4], color: "#2" },
        ],
      },
    });
    expect(container.querySelectorAll("path").length).toBe(2);
  });

  it("draws nothing for an empty series", () => {
    const { container } = render(Chart, { props: { series: [{ values: [], color: "#1" }] } });
    expect(container.querySelectorAll("path").length).toBe(0);
  });
});
