import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Skeleton from "./Skeleton.svelte";

describe("Skeleton", () => {
  it("renders a pulsing, decorative placeholder with the given size", () => {
    const { container } = render(Skeleton, {
      props: { width: "50%", height: "1rem", class: "shrink-0" },
    });
    const el = container.querySelector("span")!;
    expect(el).toBeTruthy();
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("shrink-0");
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.getAttribute("style")).toContain("width: 50%");
    expect(el.getAttribute("style")).toContain("height: 1rem");
  });
});
