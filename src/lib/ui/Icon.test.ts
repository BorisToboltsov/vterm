import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Icon from "./Icon.svelte";
import { ICONS } from "./icons";

describe("Icon", () => {
  it("renders an svg with the requested size", () => {
    const { container } = render(Icon, { props: { name: "folder", size: 20 } });
    const svg = container.querySelector("svg")!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
  });

  it("inlines the registry markup for the icon", () => {
    const { container } = render(Icon, { props: { name: "trash" } });
    // trash has three <path> segments.
    expect(container.querySelectorAll("path").length).toBe(3);
  });

  it("exposes a title as an accessible label", () => {
    const { container, getByText } = render(Icon, {
      props: { name: "close", title: "Close" },
    });
    expect(container.querySelector("svg")?.getAttribute("role")).toBe("img");
    expect(getByText("Close")).toBeInTheDocument(); // <title>
  });

  it("every registry entry is non-empty markup", () => {
    for (const [name, markup] of Object.entries(ICONS)) {
      // Almost all icons are stroke shapes; aiMark is the one text wordmark.
      expect(markup, name).toMatch(/<(path|rect|circle|ellipse|text)/);
    }
  });

  it("renders the aiMark wordmark as fill text, not a stroke", () => {
    const { container, getByText } = render(Icon, { props: { name: "aiMark", size: 16 } });
    const text = container.querySelector("text")!;
    expect(text).toBeTruthy();
    // Overrides the svg's stroke/fill so the letters are solid, not outlined.
    expect(text.getAttribute("fill")).toBe("currentColor");
    expect(text.getAttribute("stroke")).toBe("none");
    expect(getByText("Ai")).toBeInTheDocument();
  });
});
