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
});
