import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BroadcastRoster from "./BroadcastRoster.svelte";

const rows = [
  { sessionId: "a", alias: "web-2", host: "app@10.0.0.12:22", status: "Connected", dot: "bg-green-500", isProd: false, active: true },
  { sessionId: "b", alias: "db-prod", host: "app@10.0.0.31:22", status: "Connected", dot: "bg-green-500", isProd: true, active: false },
];

describe("BroadcastRoster", () => {
  it("lists every member with its alias", () => {
    render(BroadcastRoster, { props: { rows, onfocus: vi.fn(), onremove: vi.fn() } });
    expect(screen.getByText("web-2")).toBeInTheDocument();
    expect(screen.getByText("db-prod")).toBeInTheDocument();
  });

  it("marks prod members with a badge", () => {
    render(BroadcastRoster, { props: { rows, onfocus: vi.fn(), onremove: vi.fn() } });
    expect(screen.getByText("prod")).toBeInTheDocument();
  });

  it("keeps the focused member in the list and highlights it", async () => {
    render(BroadcastRoster, { props: { rows, onfocus: vi.fn(), onremove: vi.fn() } });
    // The active member (web-2) is still listed…
    const activeRow = screen.getByText("web-2").closest("div.group");
    expect(activeRow?.className).toContain("bg-accent/15");
    // …and a non-active one is not highlighted as active.
    const otherRow = screen.getByText("db-prod").closest("div.group");
    expect(otherRow?.className).not.toContain("bg-accent/15");
  });

  it("focuses a row on click", async () => {
    const onfocus = vi.fn();
    render(BroadcastRoster, { props: { rows, onfocus, onremove: vi.fn() } });
    await fireEvent.click(screen.getByText("web-2"));
    expect(onfocus).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("removes a member via its remove button", async () => {
    const onremove = vi.fn();
    render(BroadcastRoster, { props: { rows, onfocus: vi.fn(), onremove } });
    const removeButtons = screen.getAllByLabelText("Remove from broadcast group");
    await fireEvent.click(removeButtons[1]);
    expect(onremove).toHaveBeenCalledExactlyOnceWith("b");
  });
});
