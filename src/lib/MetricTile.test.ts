import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import MetricTile from "./MetricTile.svelte";

describe("MetricTile", () => {
  it("shows the big number (threshold-coloured) when no gauge is given", () => {
    const { getByText } = render(MetricTile, {
      props: { icon: "gauge", label: "Load", big: "1.23", level: "warn" },
    });
    const big = getByText("1.23");
    expect(big).toBeInTheDocument();
    expect(big).toHaveClass("text-warn");
  });

  it("renders a gauge with its text when gaugeFill is provided", () => {
    const { getByText } = render(MetricTile, {
      props: { icon: "cpu", label: "CPU", gaugeFill: 42, gaugeText: "42%" },
    });
    expect(getByText("42%")).toBeInTheDocument();
  });

  it("is a button that fires onclick", async () => {
    const onclick = vi.fn();
    const { getByTestId } = render(MetricTile, {
      props: { icon: "cpu", label: "CPU", big: "x", onclick, testid: "t" },
    });
    const el = getByTestId("t");
    expect(el.tagName).toBe("BUTTON");
    await fireEvent.click(el);
    expect(onclick).toHaveBeenCalledOnce();
  });

  it("is a plain div without onclick", () => {
    const { getByTestId } = render(MetricTile, {
      props: { icon: "cpu", label: "CPU", big: "x", testid: "t2" },
    });
    expect(getByTestId("t2").tagName).toBe("DIV");
  });
});
