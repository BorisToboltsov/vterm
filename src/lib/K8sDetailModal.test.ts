import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import K8sDetailModal from "./K8sDetailModal.svelte";
import type { K8sPod } from "./k8s";

function pod(over: Partial<K8sPod> = {}): K8sPod {
  return {
    name: "web-5f7c",
    namespace: "default",
    phase: "Running",
    status: "Running",
    ready: "1/1",
    restarts: 0,
    node: "node-1",
    age: "2h",
    containers: ["web"],
    ownerKind: "Deployment",
    ownerName: "web",
    cpuLimit: null,
    memLimit: null,
    qos: "Burstable",
    ...over,
  };
}

function props(over: Record<string, unknown> = {}) {
  return {
    open: true,
    pod: pod(),
    busy: false,
    refreshSec: 5,
    run: vi.fn().mockResolvedValue(true),
    runQuery: vi.fn().mockResolvedValue({ stdout: "log line", stderr: "", code: 0 }),
    openShell: vi.fn(),
    onclose: vi.fn(),
    ...over,
  };
}

describe("K8sDetailModal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays on the chosen tab when the poll hands over a fresh object for the same pod", async () => {
    const { rerender } = render(K8sDetailModal, { props: props() });
    await fireEvent.click(screen.getByTestId("k8s-detail-tab-logs"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("k8s-text").textContent).toContain("log line");

    await rerender({ pod: pod({ age: "3h", restarts: 1 }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("k8s-detail-overview")).toBeNull();
    expect(screen.getByTestId("k8s-text").textContent).toContain("log line");
  });

  it("resets to Overview when a different pod is opened", async () => {
    const { rerender } = render(K8sDetailModal, { props: props() });
    await fireEvent.click(screen.getByTestId("k8s-detail-tab-yaml"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId("k8s-detail-overview")).toBeNull();

    await rerender({ pod: pod({ name: "api-9d2f" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("k8s-detail-overview")).toBeTruthy();
  });

  it("treats a same-named pod in another namespace as a different pod", async () => {
    const { rerender } = render(K8sDetailModal, { props: props() });
    await fireEvent.click(screen.getByTestId("k8s-detail-tab-logs"));
    await vi.advanceTimersByTimeAsync(0);

    await rerender({ pod: pod({ namespace: "staging" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("k8s-detail-overview")).toBeTruthy();
  });
});
