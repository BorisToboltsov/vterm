import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import K8sDetail from "./K8sDetail.svelte";
import K8sDetailModal from "./K8sDetailModal.svelte";
import type { K8sPod } from "./k8s";

// A pod's details are one component in two places (v1.7): inside a dialog, and
// in a pane beside the list of a wide panel. What differs between the two is
// asked of the content by two props, not decided by it.

const pod: K8sPod = {
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
};

function props(over: Record<string, unknown> = {}) {
  return {
    active: true,
    pod,
    busy: false,
    refreshSec: 5,
    run: vi.fn().mockResolvedValue(true),
    runQuery: vi.fn().mockResolvedValue({ stdout: "log line", stderr: "", code: 0 }),
    openShell: vi.fn(),
    onclose: vi.fn(),
    ...over,
  };
}

describe("K8sDetail", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is content only: no dialog comes with it", () => {
    render(K8sDetail, { props: props() });
    expect(screen.getByTestId("k8s-detail-overview")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("fetches nothing while it is not on screen", async () => {
    const runQuery = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const view = render(K8sDetail, { props: props({ active: false, runQuery }) });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runQuery).not.toHaveBeenCalled();
    await view.rerender({ active: true });
    await fireEvent.click(screen.getByTestId("k8s-detail-tab-logs"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("its text is bounded by the window unless it is told to fill its place", async () => {
    const view = render(K8sDetail, { props: props() });
    await fireEvent.click(screen.getByTestId("k8s-detail-tab-logs"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("k8s-text").className).toContain("max-h-[60vh]");
    await view.rerender({ fill: true });
    const text = screen.getByTestId("k8s-text");
    expect(text).toHaveClass("min-h-0", "flex-1");
    expect(text.className).not.toContain("max-h-[60vh]");
  });

  it("asking the assistant closes it only where it covers the chat", async () => {
    const onAsk = vi.fn();
    const onclose = vi.fn();
    const view = render(K8sDetail, { props: props({ onAsk, onclose }) });
    await fireEvent.click(screen.getByTestId("k8s-ask-ai"));
    expect(onAsk).toHaveBeenCalledOnce();
    expect(onclose).not.toHaveBeenCalled();
    await view.rerender({ closeOnAsk: true });
    await fireEvent.click(screen.getByTestId("k8s-ask-ai"));
    expect(onclose).toHaveBeenCalledOnce();
  });
});

describe("K8sDetailModal", () => {
  it("is that content in a dialog titled with the pod, and closes on asking", async () => {
    const onAsk = vi.fn();
    const onclose = vi.fn();
    const { active: _unused, ...rest } = props({ onAsk, onclose });
    render(K8sDetailModal, { props: { ...rest, open: true } });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label", "web-5f7c");
    expect(dialog).toContainElement(screen.getByTestId("k8s-detail-overview"));
    await fireEvent.click(screen.getByTestId("k8s-ask-ai"));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("shows nothing while closed", () => {
    const { active: _unused, ...rest } = props();
    render(K8sDetailModal, { props: { ...rest, open: false } });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("k8s-detail-overview")).toBeNull();
  });
});
