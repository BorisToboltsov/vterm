import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import DisclosureRow from "./DisclosureRow.svelte";

describe("DisclosureRow", () => {
  it("renders label and count, collapsed by default", () => {
    render(DisclosureRow, { props: { label: "Templates", count: 12, testid: "d" } });
    const btn = screen.getByTestId("d");
    expect(btn).toHaveTextContent("Templates");
    expect(btn).toHaveTextContent("12");
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles aria-expanded on click", async () => {
    render(DisclosureRow, { props: { label: "Templates", testid: "d" } });
    const btn = screen.getByTestId("d");
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("omits the count when not provided", () => {
    render(DisclosureRow, { props: { label: "Rules", testid: "d" } });
    expect(screen.getByTestId("d")).toHaveTextContent("Rules");
  });
});
