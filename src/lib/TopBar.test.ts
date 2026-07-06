import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TopBar from "./TopBar.svelte";

const base = {
  title: "Timeweb",
  subtitle: "root@31.130.129.206:22",
  connected: true,
  onToggleRecording: () => {},
  onOpenRecordings: () => {},
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

  it("opens the recordings library from its button", async () => {
    const onOpenRecordings = vi.fn();
    render(TopBar, { props: { ...base, onOpenRecordings } });
    await userEvent.click(screen.getByTestId("open-recordings"));
    expect(onOpenRecordings).toHaveBeenCalledOnce();
  });

  it("shows the REC toggle only when the active tab can be recorded", () => {
    const { unmount } = render(TopBar, { props: { ...base, canRecord: false } });
    expect(screen.queryByTestId("record-toggle")).not.toBeInTheDocument();
    unmount();
    render(TopBar, { props: { ...base, canRecord: true } });
    expect(screen.getByTestId("record-toggle")).toBeInTheDocument();
  });

  it("toggles recording and reflects the running state via aria-pressed", async () => {
    const onToggleRecording = vi.fn();
    const { unmount } = render(TopBar, {
      props: { ...base, canRecord: true, recording: false, onToggleRecording },
    });
    const rec = screen.getByTestId("record-toggle");
    expect(rec).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(rec);
    expect(onToggleRecording).toHaveBeenCalledOnce();
    unmount();
    render(TopBar, { props: { ...base, canRecord: true, recording: true } });
    expect(screen.getByTestId("record-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("places the recording controls before the settings gear", () => {
    render(TopBar, { props: { ...base, canRecord: true } });
    const rec = screen.getByTestId("record-toggle");
    const lib = screen.getByTestId("open-recordings");
    const gear = screen.getByTestId("topbar-settings");
    // DOM order: REC → library → settings (rec/library sit before the gear).
    expect(rec.compareDocumentPosition(gear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lib.compareDocumentPosition(gear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
