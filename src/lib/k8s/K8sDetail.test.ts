import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import K8sDetail from "./K8sDetail.svelte";
import K8sDetailModal from "./K8sDetailModal.svelte";
import { parsePodDetail, type K8sPod } from "./k8s";

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

  it("is content only: no dialog comes with it — and opens on the log (v1.33)", () => {
    render(K8sDetail, { props: props() });
    expect(screen.getByTestId("k8s-log-tools")).toBeInTheDocument();
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
    expect(dialog).toContainElement(screen.getByTestId("k8s-log-tools"));
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

describe("K8sDetail — the pod's addresses (v1.33)", () => {
  it("names the pod's IPs and the node's, and a pod still without one", async () => {
    const view = render(K8sDetail, {
      props: props({ tab: "overview", pod: ({ ...pod,  podIps: ["10.42.1.17", "fd00::17"], hostIp: "10.0.1.11", node: "node-a" }) }),
    });
    expect(screen.getByTestId("k8s-detail-ip")).toHaveTextContent("10.42.1.17 · fd00::17");
    expect(screen.getByText("node-a").parentElement).toHaveTextContent("node-a · 10.0.1.11");
    await view.rerender({ pod: ({ ...pod,  podIps: [], hostIp: "" }) });
    expect(screen.getByTestId("k8s-detail-ip")).toHaveTextContent("No address yet");
  });

  it("says a hostNetwork pod's address is the node's", () => {
    render(K8sDetail, { props: props({ tab: "overview", pod: ({ ...pod,  podIps: ["10.0.1.11"], hostNetwork: true }) }) });
    expect(screen.getByTestId("k8s-detail-ip")).toHaveTextContent("hostNetwork");
  });
});

// Stage 1 (ADR 0054): «Overview» explains the pod from what the panel already polled.
describe("K8sDetail — Overview explains the pod (stage 1)", () => {
  const raw = {
    metadata: { name: "web-5f7c", namespace: "default", labels: { app: "web" } },
    spec: {
      serviceAccountName: "web",
      containers: [
        {
          name: "app",
          image: "busybox:1.37",
          command: ["sh", "-c", "exec httpd -f -p 8080"],
          resources: { limits: { memory: "24Mi" }, requests: { cpu: "5m" } },
          readinessProbe: { httpGet: { path: "/", port: "http", scheme: "HTTP" }, periodSeconds: 5, timeoutSeconds: 1, failureThreshold: 3 },
          env: [
            { name: "DB_PASSWORD", value: "stand-password" },
            { name: "API_TOKEN", valueFrom: { secretKeyRef: { name: "app-secret", key: "token" } } },
            { name: "GREETING", value: "hello" },
          ],
        },
      ],
      initContainers: [{ name: "log-shipper", image: "busybox:1.37", restartPolicy: "Always" }],
    },
    status: {
      phase: "Running",
      conditions: [
        { type: "Ready", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [app]", lastTransitionTime: "2026-11-07T12:59:57Z" },
      ],
      containerStatuses: [
        {
          name: "app",
          ready: false,
          restartCount: 7,
          lastState: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: "2026-11-07T13:10:45Z" } },
          state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container=app" } },
        },
      ],
      initContainerStatuses: [{ name: "log-shipper", ready: true, started: true, state: { running: { startedAt: "2026-11-07T12:59:54Z" } } }],
    },
  };
  const detail = parsePodDetail(raw);

  it("shows the conditions, each container with how it ended last time, what it runs and checks", () => {
    render(K8sDetail, { props: props({ tab: "overview", detail }) });
    const condition = screen.getByTestId("k8s-detail-condition");
    expect(condition).toHaveTextContent("Ready");
    expect(condition).toHaveTextContent("containers with unready status: [app]");
    const [app, sidecar] = screen.getAllByTestId("k8s-detail-container");
    expect(app).toHaveTextContent("CrashLoopBackOff");
    expect(app).toHaveTextContent("↻7");
    expect(app).toHaveTextContent("back-off 5m0s restarting failed container=app");
    expect(screen.getByTestId("k8s-detail-last")).toHaveTextContent("OOMKilled · exit 137");
    expect(app).toHaveTextContent('sh -c "exec httpd -f -p 8080"');
    expect(app).toHaveTextContent("requests cpu 5m");
    expect(app).toHaveTextContent("limit memory 24Mi");
    expect(screen.getByTestId("k8s-detail-probes")).toHaveTextContent("readiness GET http://:http/ every 5s · timeout 1s · fails after 3");
    expect(sidecar).toHaveTextContent("log-shipper sidecar Running");
    expect(sidecar).toHaveTextContent("the image's own");
    expect(sidecar).toHaveTextContent("none set");
  });

  it("keeps a secret-looking value masked until asked, and never shows a Secret's value", async () => {
    const view = render(K8sDetail, { props: props({ tab: "overview", detail }) });
    const env = screen.getByTestId("k8s-detail-env");
    expect(env).not.toHaveTextContent("stand-password");
    expect(env).toHaveTextContent("‹redacted›");
    expect(env).toHaveTextContent("← secret app-secret · token");
    expect(env).toHaveTextContent("hello");
    await fireEvent.click(screen.getByTestId("k8s-detail-env-reveal"));
    expect(screen.getByTestId("k8s-detail-env")).toHaveTextContent("stand-password");
    // Another pod starts masked again.
    await view.rerender({ pod: { ...pod, name: "web-other" }, detail });
    expect(screen.getByTestId("k8s-detail-env")).not.toHaveTextContent("stand-password");
  });

  it("tells the assistant how the containers ended — and nothing of the environment", async () => {
    const onAsk = vi.fn();
    render(K8sDetail, { props: props({ tab: "overview", detail, onAsk }) });
    await fireEvent.click(screen.getByTestId("k8s-detail-env-reveal"));
    await fireEvent.click(screen.getByTestId("k8s-ask-ai"));
    const told = onAsk.mock.calls[0][0] as string;
    expect(told).toContain("last time: OOMKilled exit 137");
    expect(told).toContain("Condition Ready: False (ContainersNotReady)");
    expect(told).not.toMatch(/stand-password|DB_PASSWORD|API_TOKEN|app-secret|GREETING|hello/);
  });

  it("without details it is the pod's own facts, as before", () => {
    render(K8sDetail, { props: props({ tab: "overview" }) });
    expect(screen.getByTestId("k8s-detail-overview")).toHaveTextContent("web-5f7c");
    expect(screen.queryByTestId("k8s-detail-containers")).toBeNull();
  });
});

// Stage 2 (ADR 0054): the open pod's events, by uid, while «Overview» is on screen.
describe("K8sDetail — the pod's events (stage 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const events = JSON.stringify({
    items: [
      {
        type: "Warning",
        reason: "Unhealthy",
        involvedObject: { kind: "Pod", name: "web-5f7c", uid: "uid-1", fieldPath: "spec.containers{web}" },
        metadata: { namespace: "default" },
        message: "Readiness probe failed: cat: can't open '/tmp/ready': No such file or directory",
        count: 371,
        lastTimestamp: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        type: "Normal",
        reason: "Scheduled",
        involvedObject: { kind: "Pod", name: "web-5f7c", uid: "uid-1" },
        metadata: { namespace: "default" },
        message: "Successfully assigned default/web-5f7c to node-1",
        lastTimestamp: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ],
  });
  const withUid = { ...pod, uid: "uid-1" };
  const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

  it("asks for the pod's own events by uid in its namespace, and again with every poll", async () => {
    const runQuery = vi.fn().mockResolvedValue(ok(events));
    render(K8sDetail, { props: props({ tab: "overview", pod: withUid, runQuery }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(runQuery).toHaveBeenCalledWith(["get", "events", "--field-selector=involvedObject.uid=uid-1", "-o", "json"], "default", 20);
    const [unhealthy, scheduled] = screen.getAllByTestId("k8s-detail-event");
    expect(unhealthy).toHaveTextContent("Unhealthy");
    expect(unhealthy).toHaveTextContent("web");
    expect(unhealthy).toHaveTextContent("×371");
    expect(unhealthy).toHaveTextContent("Readiness probe failed");
    expect(scheduled).toHaveTextContent("Scheduled");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  it("asks nothing while another view is on screen or it is not on screen at all", async () => {
    const runQuery = vi.fn().mockResolvedValue(ok(events));
    const view = render(K8sDetail, { props: props({ tab: "describe", pod: withUid, runQuery }) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runQuery.mock.calls.filter((c) => c[0][1] === "events")).toEqual([]);
    await view.rerender({ tab: "overview", active: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runQuery.mock.calls.filter((c) => c[0][1] === "events")).toEqual([]);
  });

  it("says when the events could not be read — that is not «no events»", async () => {
    const runQuery = vi.fn().mockResolvedValue({ stdout: "", stderr: 'Error from server (Forbidden): events is forbidden: User "dev" cannot list resource "events"', exitCode: 1 });
    render(K8sDetail, { props: props({ tab: "overview", pod: withUid, runQuery, detail: parsePodDetail({ metadata: { name: "web-5f7c" } }) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("k8s-detail-events-unread")).toHaveTextContent("events is forbidden");
    expect(screen.queryByTestId("k8s-detail-events-none")).toBeNull();
  });

  it("tells the assistant the warnings — not the routine", async () => {
    const onAsk = vi.fn();
    const runQuery = vi.fn().mockResolvedValue(ok(events));
    render(K8sDetail, { props: props({ tab: "overview", pod: withUid, runQuery, onAsk }) });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByTestId("k8s-ask-ai"));
    const told = onAsk.mock.calls[0][0] as string;
    expect(told).toContain("Event Unhealthy ×371 (web), 1m ago: Readiness probe failed");
    expect(told).not.toContain("Scheduled");
  });
});
