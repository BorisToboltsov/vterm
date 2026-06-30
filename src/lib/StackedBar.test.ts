import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import StackedBar from "./StackedBar.svelte";

describe("StackedBar", () => {
  it("renders proportional segments and a legend", () => {
    const { getByTestId, getByText } = render(StackedBar, {
      props: {
        testid: "sb",
        segments: [
          { label: "used", value: 25, color: "#a" },
          { label: "free", value: 75, color: "#b" },
        ],
      },
    });
    const bar = getByTestId("sb").querySelector("div");
    const spans = bar?.querySelectorAll(":scope > span");
    expect(spans?.length).toBe(2);
    expect((spans?.[0] as HTMLElement).style.width).toBe("25%");
    expect(getByText("used")).toBeInTheDocument();
    expect(getByText("free")).toBeInTheDocument();
  });

  it("omits the legend when legend is false", () => {
    const { queryByText } = render(StackedBar, {
      props: { legend: false, segments: [{ label: "x", value: 1, color: "#a" }] },
    });
    expect(queryByText("x")).toBeNull();
  });

  it("skips zero-value segments in the bar", () => {
    const { getByTestId } = render(StackedBar, {
      props: {
        testid: "sb2",
        legend: false,
        segments: [
          { label: "a", value: 0, color: "#a" },
          { label: "b", value: 5, color: "#b" },
        ],
      },
    });
    const bar = getByTestId("sb2").querySelector("div");
    expect(bar?.querySelectorAll(":scope > span").length).toBe(1);
  });
});
