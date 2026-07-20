import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DockerDetailModal from "./DockerDetailModal.svelte";
import type { DockerContainer } from "./docker";

function container(over: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "abc123456789",
    name: "web",
    image: "nginx:1.27",
    state: "running",
    status: "Up 2 hours",
    ports: "0.0.0.0:80->80/tcp",
    project: "",
    service: "",
    workdir: null,
    createdAt: "2026-07-19 10:00:00",
    runningFor: "2 hours",
    ...over,
  };
}

function props(over: Record<string, unknown> = {}) {
  return {
    open: true,
    container: container(),
    busy: false,
    refreshSec: 3,
    run: vi.fn().mockResolvedValue(true),
    runQuery: vi.fn().mockResolvedValue({ stdout: "log line", stderr: "", code: 0 }),
    onShell: vi.fn(),
    onclose: vi.fn(),
    ...over,
  };
}

describe("DockerDetailModal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens on Overview", () => {
    render(DockerDetailModal, { props: props() });
    expect(screen.getByTestId("docker-detail-overview")).toBeTruthy();
  });

  it("stays on the chosen tab when the poll hands over a fresh object for the same container", async () => {
    const { rerender } = render(DockerDetailModal, { props: props() });
    await fireEvent.click(screen.getByTestId("docker-detail-tab-logs"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("docker-text").textContent).toContain("log line");

    // What the panel does every `refreshSec`: same container, new object (and a
    // changed status line). Must not count as "a different container".
    await rerender({ container: container({ status: "Up 3 hours" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("docker-detail-overview")).toBeNull();
    expect(screen.getByTestId("docker-text").textContent).toContain("log line");
  });

  it("resets to Overview when a different container is opened", async () => {
    const { rerender } = render(DockerDetailModal, { props: props() });
    await fireEvent.click(screen.getByTestId("docker-detail-tab-inspect"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("docker-detail-overview")).toBeNull();

    await rerender({ container: container({ id: "def987654321", name: "db" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("docker-detail-overview")).toBeTruthy();
  });

  it("keeps exactly one logs poller alive across snapshots", async () => {
    const p = props();
    const { rerender } = render(DockerDetailModal, { props: p });
    await fireEvent.click(screen.getByTestId("docker-detail-tab-logs"));
    await vi.advanceTimersByTimeAsync(0);

    await rerender({ container: container({ status: "Up 3 hours" }) });
    await vi.advanceTimersByTimeAsync(0);
    const before = p.runQuery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    // One tick per interval — a stacked second interval would double this.
    expect(p.runQuery.mock.calls.length).toBe(before + 1);
  });
});
