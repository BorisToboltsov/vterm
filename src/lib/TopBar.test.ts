import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import TopBar from "./TopBar.svelte";

describe("TopBar", () => {
  it("shows the connection status", () => {
    render(TopBar, { props: { status: "Connected" } });
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("no longer renders an add-server button (moved to the server tree)", () => {
    render(TopBar, { props: { status: "Connected" } });
    expect(screen.queryByTestId("add-server")).not.toBeInTheDocument();
  });
});
