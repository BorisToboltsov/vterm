import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TopBar from "./TopBar.svelte";

describe("TopBar", () => {
  it("shows the status and fires onAdd", async () => {
    const onAdd = vi.fn();
    render(TopBar, { props: { status: "Connected", onAdd } });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("add-server"));
    expect(onAdd).toHaveBeenCalledOnce();
  });
});
