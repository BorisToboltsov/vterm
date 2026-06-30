import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Gauge from "./Gauge.svelte";

describe("Gauge", () => {
  it("renders the centred text and exposes it as the accessible name", () => {
    const { getByTestId, getByText } = render(Gauge, {
      props: { fill: 42, text: "42%", testid: "g" },
    });
    expect(getByText("42%")).toBeInTheDocument();
    expect(getByTestId("g")).toHaveAttribute("aria-label", "42%");
  });

  it("colours the value arc by threshold level", () => {
    const { container } = render(Gauge, { props: { fill: 90, text: "90%", level: "crit" } });
    const arc = container.querySelector('circle[stroke-linecap="round"]');
    expect(arc).toHaveAttribute("stroke", "var(--color-danger)");
  });

  it("draws no value arc when fill is null", () => {
    const { container } = render(Gauge, { props: { fill: null, text: "—" } });
    expect(container.querySelector('circle[stroke-linecap="round"]')).toBeNull();
  });
});
