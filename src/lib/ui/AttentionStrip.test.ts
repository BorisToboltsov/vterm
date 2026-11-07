import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AttentionStrip from "./AttentionStrip.svelte";

const items = [
  { key: "a", name: "shop-api-1", tone: "warn" as const, reason: "Health check failing", detail: "↻3" },
  { key: "b", name: "old-migrate", tone: "bad" as const, reason: "Exited with an error", detail: "exit 1" },
];

describe("AttentionStrip", () => {
  it("is not drawn with nothing to report", () => {
    render(AttentionStrip, { props: { items: [], onpick: vi.fn() } });
    expect(screen.queryByTestId("attention")).toBeNull();
  });

  it("names each item with why, takes the worst tone, and opens the picked one", async () => {
    const onpick = vi.fn();
    render(AttentionStrip, { props: { items, onpick } });
    const toggle = screen.getByTestId("attention-toggle");
    expect(toggle).toHaveTextContent("Needs attention · 2");
    expect(toggle.className).toContain("text-bad");
    const rows = screen.getAllByTestId("attention-item");
    expect(rows[0].textContent?.replace(/\s+/g, " ").trim()).toBe("shop-api-1 Health check failing ↻3");
    await fireEvent.click(rows[1]);
    expect(onpick).toHaveBeenCalledWith("b");
  });

  it("folds to its title", async () => {
    render(AttentionStrip, { props: { items: items.slice(0, 1), onpick: vi.fn() } });
    const toggle = screen.getByTestId("attention-toggle");
    expect(toggle.className).toContain("text-warn");
    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("attention-list")).toBeNull();
  });
});
