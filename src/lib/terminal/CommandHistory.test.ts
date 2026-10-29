import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import CommandHistory from "./CommandHistory.svelte";

const items = ["git push origin main", "npm run build", "git status"];

function setup(overrides = {}) {
  const onaccept = vi.fn();
  const onclose = vi.fn();
  render(CommandHistory, {
    props: { open: true, items, onaccept, onclose, ...overrides },
  });
  // Focus the field so keyboard events hit the overlay's handler deterministically.
  screen.queryByRole("textbox")?.focus();
  return { onaccept, onclose };
}

describe("CommandHistory", () => {
  it("lists all commands and the count when open", () => {
    setup();
    const overlay = screen.getByTestId("command-history");
    expect(overlay).toHaveTextContent("git push origin main");
    expect(overlay).toHaveTextContent("3/3");
  });

  it("filters as the user types and updates the count", async () => {
    setup();
    await userEvent.keyboard("git");
    const overlay = screen.getByTestId("command-history");
    expect(overlay).toHaveTextContent("git push origin main");
    expect(overlay).toHaveTextContent("git status");
    expect(overlay).not.toHaveTextContent("npm run build");
    expect(overlay).toHaveTextContent("2/3");
  });

  it("accepts the first command on Enter", async () => {
    const { onaccept } = setup();
    await userEvent.keyboard("{Enter}");
    expect(onaccept).toHaveBeenCalledWith("git push origin main");
  });

  it("moves the selection with arrows before accepting", async () => {
    const { onaccept } = setup();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onaccept).toHaveBeenCalledWith("npm run build");
  });

  it("accepts a command on click", async () => {
    const { onaccept } = setup();
    await userEvent.click(screen.getByText("git status"));
    expect(onaccept).toHaveBeenCalledWith("git status");
  });

  it("closes on Escape", async () => {
    const { onclose } = setup();
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalled();
  });

  it("closes when the ✕ button is clicked", async () => {
    const { onclose } = setup();
    await userEvent.click(screen.getByTestId("command-history-close"));
    expect(onclose).toHaveBeenCalled();
  });

  it("shows the empty state when there is no history", () => {
    setup({ items: [] });
    expect(screen.getByTestId("command-history")).toHaveTextContent("No command history");
  });

  it("shows an error when reading history failed", () => {
    setup({ error: "boom" });
    expect(screen.getByTestId("command-history")).toHaveTextContent("boom");
  });
});
