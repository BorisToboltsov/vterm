import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TopBar from "./TopBar.svelte";

const base = {
  title: "Timeweb",
  subtitle: "root@31.130.129.206:22",
  connected: true,
  onOpenMonitoring: () => {},
  onOpenSettings: () => {},
};

describe("TopBar", () => {
  it("shows the connection breadcrumb (alias · user@host:port)", () => {
    render(TopBar, { props: { ...base } });
    expect(screen.getByText("Timeweb")).toBeInTheDocument();
    expect(screen.getByText("root@31.130.129.206:22")).toBeInTheDocument();
  });

  it("opens settings from the gear button", async () => {
    const onOpenSettings = vi.fn();
    render(TopBar, { props: { ...base, onOpenSettings } });
    await userEvent.click(screen.getByTestId("topbar-settings"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("opens monitoring from its button while connected", async () => {
    const onOpenMonitoring = vi.fn();
    render(TopBar, { props: { ...base, connected: true, onOpenMonitoring } });
    await userEvent.click(screen.getByTestId("topbar-monitoring"));
    expect(onOpenMonitoring).toHaveBeenCalledOnce();
  });

  it("hides the monitoring button when not connected", () => {
    render(TopBar, { props: { ...base, connected: false } });
    expect(screen.queryByTestId("topbar-monitoring")).not.toBeInTheDocument();
    // Settings stays available regardless.
    expect(screen.getByTestId("topbar-settings")).toBeInTheDocument();
  });

  it("no longer renders the brand or an add-server button", () => {
    render(TopBar, { props: { ...base } });
    expect(screen.queryByText("vterm")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-server")).not.toBeInTheDocument();
  });
});
