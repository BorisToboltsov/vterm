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

  it("colours the failed phase as danger in failed mode", () => {
    render(ConnectingOverlay, {
      props: { alias: "prod-db", host: "deploy@10.0.0.5:22", phase: "session", failed: true },
    });
    expect(screen.getByText("Session").className).toContain("text-danger");
  });

  it("renders the error title, red detail and alert role in failed mode", () => {
    render(ConnectingOverlay, {
      props: {
        alias: "prod-db",
        host: "deploy@10.0.0.5:22",
        phase: "connecting",
        failed: true,
        title: "Couldn't connect",
        detail: "Connection refused",
      },
    });
    expect(screen.getByText("Couldn't connect")).toBeInTheDocument();
    expect(screen.getByText("Connection refused").className).toContain("text-danger");
    expect(screen.getByTestId("connecting-overlay")).toHaveAttribute("role", "alert");
  });

  it("hides the checklist when showSteps is false", () => {
    render(ConnectingOverlay, {
      props: {
        alias: "prod-db",
        host: "deploy@10.0.0.5:22",
        failed: true,
        showSteps: false,
        title: "Connection lost",
      },
    });
    expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  });

  it("renders a flat checklist with no group headers for a direct connection", () => {
    render(ConnectingOverlay, {
      props: { alias: "prod-db", host: "deploy@10.0.0.5:22", phase: "connecting" },
    });
    expect(screen.queryByTestId("connecting-groups")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connecting-proxy-header")).not.toBeInTheDocument();
  });

  it("groups jump-host sub-steps under the proxy address, target steps under the host", () => {
    render(ConnectingOverlay, {
      props: {
        alias: "prod-db",
        host: "deploy@10.0.0.5:22",
        phase: "proxyAuthenticating",
        proxy: "jump" as const,
        via: "bastion.corp:22",
      },
    });
    // Two group headers with the proxy and server addresses.
    expect(screen.getByTestId("connecting-proxy-header")).toHaveTextContent("bastion.corp:22");
    expect(screen.getByTestId("connecting-server-header")).toHaveTextContent("deploy@10.0.0.5:22");
    // Jump host's own auth sub-step is active (accent + ellipsis).
    expect(screen.getByText("Authentication…").className).toContain("text-accent");
    // Tunnel sub-step (jump-only) is present and pending.
    expect(screen.getByText("Tunnel")).toBeInTheDocument();
  });

  it("shows only connect + handshake proxy sub-steps for a tcp proxy", () => {
    render(ConnectingOverlay, {
      props: {
        alias: "prod-db",
        host: "deploy@10.0.0.5:22",
        phase: "proxyHandshake",
        proxy: "tcp" as const,
        via: "socks.corp:1080",
      },
    });
    expect(screen.getByText("Handshake…")).toBeInTheDocument();
    // No SSH "Tunnel" sub-step for a dumb TCP proxy.
    expect(screen.queryByText("Tunnel")).not.toBeInTheDocument();
  });
});
