import { render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import K8sNodeDetail from "./K8sNodeDetail.svelte";
import { parseNodeDetail, parseNodes } from "./k8s";

// Stage 5 (ADR 0054): a node's details. The node is the stand's (Docker Desktop's
// k8s 1.31.1), trimmed; a pressure and a taint are added to show how they read.

const NODE_OBJ = {
  metadata: { name: "desktop-control-plane", creationTimestamp: "2026-11-07T12:49:00Z", labels: { "node-role.kubernetes.io/control-plane": "" } },
  spec: { taints: [{ key: "dedicated", value: "db", effect: "NoExecute" }] },
  status: {
    capacity: { cpu: "8", memory: "12235532Ki", pods: "110" },
    allocatable: { cpu: "8", memory: "12235532Ki", pods: "110" },
    conditions: [
      { type: "MemoryPressure", status: "False", reason: "KubeletHasSufficientMemory" },
      { type: "DiskPressure", status: "True", reason: "KubeletHasDiskPressure", message: "kubelet has disk pressure" },
      { type: "Ready", status: "True", reason: "KubeletReady" },
    ],
    addresses: [{ type: "InternalIP", address: "172.23.0.2" }],
    nodeInfo: { kubeletVersion: "v1.31.1", containerRuntimeVersion: "containerd://1.7.18", osImage: "Debian GNU/Linux 12 (bookworm)", kernelVersion: "6.12.67-linuxkit", architecture: "arm64" },
  },
};
const node = parseNodes(JSON.stringify({ items: [NODE_OBJ] }))[0];
const pod = (name: string, ns: string, phase: string, cpu: string, mem: string) => ({
  metadata: { name, namespace: ns },
  spec: { nodeName: "desktop-control-plane", containers: [{ name: "c", resources: { requests: { cpu, memory: mem } } }] },
  status: { phase },
});
const PODS = JSON.stringify({
  items: [pod("coredns-1", "kube-system", "Running", "100m", "70Mi"), pod("web-1", "vterm-stand", "Running", "15m", "24Mi"), pod("migrate-x", "vterm-stand", "Succeeded", "1", "1Gi")],
});

function answer(top: { stdout: string; stderr: string; exitCode: number }) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === "top") return top;
    if (args[1] === "pods") return { stdout: PODS, stderr: "", exitCode: 0 };
    return { stdout: `text of ${args.join(" ")}`, stderr: "", exitCode: 0 };
  });
}
const TOP = { stdout: "desktop-control-plane   252m   3%    957Mi   8%\n", stderr: "", exitCode: 0 };

describe("K8sNodeDetail (stage 5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says what is wrong with the node, and how it is tainted", () => {
    render(K8sNodeDetail, { props: { active: true, node, detail: parseNodeDetail(NODE_OBJ), runQuery: answer(TOP) } });
    const conditions = screen.getAllByTestId("k8s-node-condition");
    expect(conditions.map((c) => c.textContent?.trim().split(/\s+/)[0])).toEqual(["Ready", "MemoryPressure", "DiskPressure"]);
    expect(conditions[2]).toHaveTextContent("kubelet has disk pressure");
    expect(conditions[1]).not.toHaveTextContent("kubelet");
    expect(screen.getByTestId("k8s-node-taints")).toHaveTextContent("dedicated=db:NoExecute");
    expect(screen.getByTestId("k8s-node-overview")).toHaveTextContent("Debian GNU/Linux 12 (bookworm) · 6.12.67-linuxkit · arm64");
  });

  it("asks its pods across namespaces and its usage, and sums what the running ones ask for", async () => {
    const runQuery = answer(TOP);
    render(K8sNodeDetail, { props: { active: true, node, detail: parseNodeDetail(NODE_OBJ), runQuery } });
    await vi.advanceTimersByTimeAsync(0);
    expect(runQuery).toHaveBeenCalledWith(["get", "pods", "-A", "--field-selector=spec.nodeName=desktop-control-plane", "-o", "json"], "", 20);
    expect(runQuery).toHaveBeenCalledWith(["top", "node", "desktop-control-plane", "--no-headers"], "", 20);
    const parts = screen.getAllByTestId("k8s-node-resource").map((r) => r.textContent?.replace(/\s+/g, " ").trim());
    // CPU: 115m of 8 asked, 252m used now; memory: 94Mi asked of 11.7Gi; two pods hold
    // resources — the finished one does not.
    expect(parts).toContain("requested 115m 1%");
    expect(parts).toContain("using now 252m 3%");
    expect(parts).toContain("requested 94Mi 1%");
    expect(parts).toContain("requested 2 2%");
    expect(screen.getAllByTestId("k8s-node-pod").map((p) => p.textContent)).toEqual([
      expect.stringContaining("coredns-1"),
      expect.stringContaining("web-1"),
      expect.stringContaining("migrate-x"),
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runQuery.mock.calls.filter((c) => c[0][0] === "top")).toHaveLength(2);
  });

  it("without metrics-server says what it does not know, and still sums the requests", async () => {
    render(K8sNodeDetail, {
      props: { active: true, node, detail: parseNodeDetail(NODE_OBJ), runQuery: answer({ stdout: "", stderr: "error: Metrics API not available", exitCode: 1 }) },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("k8s-node-usage-gap")).toHaveTextContent("no metrics-server");
    const parts = screen.getAllByTestId("k8s-node-resource").map((r) => r.textContent ?? "");
    expect(parts.some((p) => p.includes("using now"))).toBe(false);
    expect(parts.some((p) => p.includes("requested 115m"))).toBe(true);
  });

  it("asks nothing while another view is on screen, and reads that view's text", async () => {
    const runQuery = answer(TOP);
    render(K8sNodeDetail, { props: { active: true, node, detail: parseNodeDetail(NODE_OBJ), runQuery, tab: "yaml" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runQuery.mock.calls.map((c) => c[0].join(" "))).toEqual(["get node desktop-control-plane -o yaml"]);
    expect(screen.getByTestId("k8s-node-text")).toHaveTextContent("text of get node desktop-control-plane -o yaml");
  });
});
