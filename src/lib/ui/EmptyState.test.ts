import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import EmptyState from "./EmptyState.svelte";

const action = createRawSnippet(() => ({
  render: () => `<button>Do it</button>`,
}));

describe("EmptyState", () => {
  it("renders the icon, title and hint", () => {
    const { container } = render(EmptyState, {
      props: { icon: "server", title: "No servers", hint: "Add one to begin." },
    });
    expect(screen.getByText("No servers")).toBeInTheDocument();
    expect(screen.getByText("Add one to begin.")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("omits the hint when not provided", () => {
    render(EmptyState, { props: { icon: "server", title: "Empty" } });
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });

  it("renders action children in the slot", () => {
    render(EmptyState, {
      props: { icon: "server", title: "Empty", children: action },
    });
    expect(screen.getByRole("button", { name: "Do it" })).toBeInTheDocument();
  });

  describe("fits its room (v1.30)", () => {
    /** Give the root `room` px; its content needs what the tier it is in needs. */
    function room(root: HTMLElement, px: number) {
      const needs: Record<string, number> = { full: 200, medal: 120, line: 70, title: 30 };
      Object.defineProperty(root, "clientHeight", { configurable: true, value: px });
      Object.defineProperty(root, "scrollHeight", {
        configurable: true,
        get: () => Math.max(px, needs[root.dataset.tier ?? ""] ?? 0),
      });
      const observers = (
        globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
      ).instances;
      for (const o of observers) o.cb([{ target: root }]);
    }

    it("starts roomiest and steps down to what fits — badge, medallion, row, title", () => {
      render(EmptyState, {
        props: { icon: "plug", title: "No connection", hint: "Reconnect.", children: action },
      });
      const root = screen.getByTestId("empty-state");
      expect(root.dataset.tier).toBe("full");
      const seen = [400, 150, 90, 20].map((px) => {
        room(root, px);
        return root.dataset.tier;
      });
      expect(seen).toEqual(["full", "medal", "line", "title"]);
      room(root, 400);
      expect(root.dataset.tier).toBe("full");
    });

    it("keeps one set of actions and the hint, whatever the tier", () => {
      render(EmptyState, {
        props: { icon: "plug", title: "No connection", hint: "Reconnect.", children: action },
      });
      room(screen.getByTestId("empty-state"), 20);
      // The tightest tier hides the hint from the eye only: a screen reader
      // still reads why the panel is empty.
      expect(screen.getByText("Reconnect.").parentElement!.className).toMatch(
        /group-data-\[tier=title\]\/empty:sr-only/,
      );
      expect(screen.getAllByRole("button", { name: "Do it" })).toHaveLength(1);
      expect(screen.getAllByText("No connection")).toHaveLength(1);
    });
  });
});
