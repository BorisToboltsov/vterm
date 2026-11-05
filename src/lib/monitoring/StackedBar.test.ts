import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import StackedBar from "./StackedBar.svelte";

const bar = (el: HTMLElement) => [...el.querySelector("div")!.querySelectorAll<HTMLElement>(":scope > span")];

describe("StackedBar", () => {
  it("places each part by transform, in proportion, and shows a legend with values", () => {
    const { getByTestId, getByText } = render(StackedBar, {
      props: {
        testid: "sb",
        segments: [
          { label: "used", value: 25, color: "#a", text: "2 GiB" },
          { label: "free", value: 75, color: "#b" },
        ],
      },
    });
    const parts = bar(getByTestId("sb"));
    expect(parts.map((p) => p.dataset.share)).toEqual(["25", "75"]);
    expect(parts[1].style.transform).toBe("translateX(25%) scaleX(0.75)");
    expect(getByText("used")).toBeInTheDocument();
    expect(getByText("2 GiB")).toBeInTheDocument();
  });

  it("omits the legend when legend is false", () => {
    const { queryByText } = render(StackedBar, {
      props: { legend: false, segments: [{ label: "x", value: 1, color: "#a" }] },
    });
    expect(queryByText("x")).toBeNull();
  });

  it("keeps a part that drops to zero, shrunk — it does not vanish and shove its neighbours", () => {
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
    const parts = bar(getByTestId("sb2"));
    expect(parts.length).toBe(2);
    expect(parts[0].style.transform).toBe("translateX(0%) scaleX(0)");
  });
});
