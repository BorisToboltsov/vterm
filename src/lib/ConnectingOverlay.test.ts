import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import ConnectingOverlay from "./ConnectingOverlay.svelte";

describe("ConnectingOverlay", () => {
  it("shows the alias title and host caption", () => {
    render(ConnectingOverlay, { props: { alias: "prod-db", host: "deploy@10.0.0.5:22" } });
    expect(screen.getByText("Connecting to prod-db…")).toBeInTheDocument();
    expect(screen.getByText("deploy@10.0.0.5:22")).toBeInTheDocument();
    expect(screen.getByTestId("connecting-overlay")).toHaveAttribute("role", "status");
  });

  it("marks the active phase and the ones before it as done", () => {
    render(ConnectingOverlay, {
      props: { alias: "prod-db", host: "deploy@10.0.0.5:22", phase: "authenticating" },
    });
    // Earlier phase rendered as a plain (done) label.
    expect(screen.getByText("Connection")).toBeInTheDocument();
    // Active phase gets the accent colour and a trailing ellipsis.
    const active = screen.getByText("Authentication…");
    expect(active.className).toContain("text-accent");
  });

  it("colours the failed phase as danger when errored", () => {
    render(ConnectingOverlay, {
      props: { alias: "prod-db", host: "deploy@10.0.0.5:22", phase: "session", errored: true },
    });
    expect(screen.getByText("Session").className).toContain("text-danger");
  });
});
