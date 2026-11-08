import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A cluster that answers: a kubeconfig with a current context, two namespaces.
// Each call takes a macrotask, like a real IPC round trip — the storm this file
// guards against needs the answers to arrive *after* the effects have settled.
const calls: string[] = [];
type Answer = { stdout: string; stderr: string; exitCode: number };
// A test's own answers, tried before the defaults below (the hoisted mock reads it lazily).
let answer: ((args: string[]) => Answer | undefined) | null = null;
// How long one call takes, when a test needs an answer to arrive late.
let slow: ((args: string[]) => number) | null = null;
// Calls asked and not answered yet — what `idle` waits out.
let inFlight = 0;
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  kubectlRun: vi.fn(async (_session: string, args: string[]) => {
    calls.push(args.join(" "));
    inFlight++;
    try {
      await new Promise((r) => setTimeout(r, slow?.(args) ?? 5));
    } finally {
      inFlight--;
    }
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    const own = answer?.(args);
    if (own) return own;
    if (args.includes("version")) {
      return ok(
        JSON.stringify({
          clientVersion: { gitVersion: "v1.31.1" },
          serverVersion: { gitVersion: "v1.30.4" },
        }),
      );
    }
    if (args.includes("get-contexts")) return ok("prod-eu\nstaging-eu\n");
    if (args.includes("current-context")) return ok("staging-eu\n");
    if (args.includes("namespaces")) {
      return ok(JSON.stringify({ items: [{ metadata: { name: "shop" } }] }));
    }
    return ok(JSON.stringify({ items: [] }));
  }),
}));

import K8sPanel from "./K8sPanel.svelte";
import { peekDockState, resetDockState } from "../stores/dockstate.svelte";
import { panelSplits, resetPanelShares } from "../stores/panelsplit.svelte";

/** A fixed pause — only for "and nothing more happens": there is no event to wait for. */
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the panel has finished what it started: no call in flight, and
 * none begun for a few turns of the event loop after.
 *
 * Not a pause. "120 ms is enough for six calls of 5 ms" is a bet on how busy the
 * machine is, and a full run under load lost it: a timer that fires late makes
 * every hop of the chain late, and the test looked at a panel that had not
 * finished loading. The panel's calls follow one another without a timer in
 * between — the next is asked in the same turn the last one answered — so a
 * turn with nothing in flight means the chain is over; three in a row is margin.
 * A chain that never ends (the storm this file guards against) is cut off, and
 * the counts that follow say what went wrong.
 */
async function idle(): Promise<void> {
  const until = Date.now() + 4000;
  let quiet = 0;
  let seen = calls.length;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
    if (inFlight === 0 && calls.length === seen) {
      if (++quiet === 3) return;
    } else {
      quiet = 0;
      seen = calls.length;
    }
  }
}
/** How many times a command was run, matched by a distinctive fragment of its argv. */
const count = (fragment: string) => calls.filter((c) => c.includes(fragment)).length;

beforeEach(() => {
  calls.length = 0;
  answer = null;
  slow = null;
  resetDockState();
});
// A test that ends with calls still out must not leave them to the next one.
afterEach(idle);

describe("K8sPanel — probing the cluster", () => {
  it("probes a host with a kubeconfig once, not in a loop", async () => {
    // Before v1.1.0 the init effect depended on the scope it wrote itself: picking
    // up the kubeconfig's current context re-ran the init, which reset the context
    // and probed again — every answer started two more probes. One mount made tens
    // of thousands of `kubectl` calls a second on the session's host.
    render(K8sPanel, { props: { sessionId: "k1", visible: true, sessionReady: true } });
    await idle();
    expect(count("get-contexts")).toBe(1);
    expect(count("current-context")).toBe(1);
    expect(count("version")).toBe(1);
    expect(count("get namespaces")).toBe(1);
    expect(count("get pods")).toBe(1);
    expect(count("top pods")).toBe(1);
    // …and it stays quiet afterwards (the poll interval is seconds away).
    const total = calls.length;
    await settle();
    expect(calls.length).toBe(total);
  });

  it("uses the kubeconfig's current context for every command after the probe", async () => {
    render(K8sPanel, { props: { sessionId: "k2", visible: true, sessionReady: true } });
    await idle();
    // The context selector shows it, and it was not reset behind the user's back.
    expect((screen.getByTestId("k8s-context") as HTMLSelectElement).value).toBe("staging-eu");
    expect(calls.find((c) => c.includes("get pods"))).toContain("--context staging-eu");
  });

  it("reloads once when a namespace is picked, without probing again", async () => {
    render(K8sPanel, { props: { sessionId: "k3", visible: true, sessionReady: true } });
    await idle();
    calls.length = 0;
    await fireEvent.change(screen.getByTestId("k8s-namespace"), { target: { value: "shop" } });
    await idle();
    expect(count("get pods")).toBe(1);
    expect(count("top pods")).toBe(1);
    expect(calls.find((c) => c.includes("get pods"))).toContain("--namespace shop");
    // Picking a namespace is not a new cluster: no re-enumeration, no version probe.
    expect(count("get-contexts")).toBe(0);
    expect(count("version")).toBe(0);
  });

  it("reloads once when the sub-tab changes", async () => {
    render(K8sPanel, { props: { sessionId: "k4", visible: true, sessionReady: true } });
    await idle();
    calls.length = 0;
    await fireEvent.click(screen.getByTestId("k8s-subtab-workloads"));
    await idle();
    expect(count("get deployments")).toBe(1);
    expect(count("version")).toBe(0);
  });

  it("does not touch the cluster before the session is ready", async () => {
    render(K8sPanel, { props: { sessionId: "k5", visible: true, sessionReady: false } });
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("K8sPanel — the route view", () => {
  const json = (...items: unknown[]) => ({ stdout: JSON.stringify({ items }), stderr: "", exitCode: 0 });
  const web = {
    metadata: { name: "web", namespace: "shop" },
    spec: { clusterIP: "10.0.0.12", selector: { app: "web" }, ports: [{ name: "http", port: 80, targetPort: 8080 }] },
  };
  const webSlice = {
    metadata: { name: "web-abcde", namespace: "shop", labels: { "kubernetes.io/service-name": "web" } },
    ports: [{ name: "http", port: 8080 }],
    endpoints: [{ addresses: ["10.1.0.5"], conditions: { ready: true }, targetRef: { kind: "Pod", name: "web-abc" } }],
  };

  async function openNetwork(session: string) {
    render(K8sPanel, { props: { sessionId: session, visible: true, sessionReady: true } });
    await idle();
    calls.length = 0;
    await fireEvent.click(screen.getByTestId("k8s-subtab-network"));
    await idle();
  }

  it("does not ask for EndpointSlices while the list is on screen", async () => {
    // The list view polls exactly what it polled before the route existed.
    await openNetwork("r1");
    expect(count("get services")).toBe(1);
    expect(count("get ingress")).toBe(1);
    expect(count("get endpointslices")).toBe(0);
  });

  it("reloads once, with the slices, when the route is switched on", async () => {
    answer = (args) => (args.includes("services") ? json(web) : args.includes("endpointslices") ? json(webSlice) : undefined);
    await openNetwork("r2");
    calls.length = 0;
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    await idle();
    expect(count("get services")).toBe(1);
    expect(count("get ingress -o")).toBe(1);
    expect(count("get endpointslices")).toBe(1);
    expect(calls.find((c) => c.includes("endpointslices"))).toContain("--context staging-eu");
    // What else the route reads (v1.35): IngressClasses are the cluster's, not a namespace's.
    expect(count("get httproutes.gateway.networking.k8s.io")).toBe(1);
    expect(count("get networkpolicies")).toBe(1);
    expect(count("get ingressclasses")).toBe(1);
    expect(calls.find((c) => c.includes("ingressclasses"))).not.toMatch(/ -n | -A/);
    expect(screen.getByTestId("k8s-route-endpoint")).toHaveTextContent("10.1.0.5");
    expect(screen.getByText("1 of 1 ready")).toBeInTheDocument();
    // …and stops asking for them once the list is back.
    calls.length = 0;
    await fireEvent.click(screen.getByRole("button", { name: "List" }));
    await idle();
    expect(count("get endpointslices")).toBe(0);
    expect(count("get httproutes")).toBe(0);
    expect(count("get networkpolicies")).toBe(0);
    expect(count("get ingressclasses")).toBe(0);
  });

  it("says the endpoints were not read when the cluster refuses the slices", async () => {
    // EndpointSlices live in their own API group: a role that lists services may
    // not list them. That is not "this service has no endpoints".
    const forbidden = 'Error from server (Forbidden): endpointslices.discovery.k8s.io is forbidden: User "dev" cannot list resource';
    answer = (args) =>
      args.includes("services")
        ? json(web)
        : args.includes("endpointslices")
          ? { stdout: "", stderr: forbidden, exitCode: 1 }
          : undefined;
    await openNetwork("r3");
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    await idle();
    expect(screen.getByText("Endpoints could not be read")).toBeInTheDocument();
    expect(screen.queryByText("No endpoints — traffic has nowhere to go")).toBeNull();
  });

  it("reports a service load failure instead of 'No services'", async () => {
    answer = (args) =>
      args.includes("services") ? { stdout: "", stderr: "Error from server (Forbidden): services is forbidden", exitCode: 1 } : undefined;
    await openNetwork("r4");
    expect(screen.getByText("Couldn't load services")).toBeInTheDocument();
    expect(screen.queryByText("No services")).toBeNull();
    // The switch stays reachable above the message.
    expect(screen.getByTestId("k8s-net-view")).toBeInTheDocument();
  });

  it("keeps the endpoints when an answer asked for under the list arrives late", async () => {
    // A reload started in the list view carries no slices. If it lands after the
    // route's own reload, it must not wipe the endpoints that one brought.
    answer = (args) => (args.includes("services") ? json(web) : args.includes("endpointslices") ? json(webSlice) : undefined);
    await openNetwork("r6");
    let late = true;
    slow = (args) => {
      if (late && args.includes("services")) {
        late = false;
        return 80;
      }
      return 5;
    };
    await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    // Both reloads, the late one too.
    await idle();
    expect(screen.getByTestId("k8s-route-endpoint")).toHaveTextContent("10.1.0.5");
  });

  it("remembers the view for the session", async () => {
    answer = (args) => (args.includes("services") ? json(web) : args.includes("endpointslices") ? json(webSlice) : undefined);
    await openNetwork("r5");
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    await idle();
    expect(peekDockState("r5")?.sub).toMatchObject({ k8s: "network", k8sNet: "route" });
  });
});

// ── Details beside the list in a wide panel (v1.7) ───────────────────────────

describe("K8sPanel — where a pod's details open", () => {
  const POD = {
    metadata: {
      name: "web-5f7c",
      namespace: "shop",
      creationTimestamp: "2026-10-07T10:00:00Z",
      ownerReferences: [],
    },
    spec: { nodeName: "node-1", containers: [{ name: "web" }] },
    status: { phase: "Running", containerStatuses: [{ name: "web", state: { running: {} }, ready: true, restartCount: 0 }] },
  };

  /** Give the panel a width and let its observer see it (jsdom has no layout). */
  function resize(width: number) {
    const root = document.querySelector<HTMLElement>("[data-wide]")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([]);
  }

  async function mountWithPod(id: string) {
    answer = (args) =>
      args.includes("pods") && args.includes("get")
        ? { stdout: JSON.stringify({ items: [POD] }), stderr: "", exitCode: 0 }
        : undefined;
    render(K8sPanel, { props: { sessionId: id, visible: true, sessionReady: true } });
    await idle();
    expect(screen.getByText("web-5f7c")).toBeInTheDocument();
  }

  it("a narrow dock opens them as a dialog", async () => {
    await mountWithPod("k-narrow");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    // On the log (v1.33): it is what a pod is opened for.
    expect(screen.getByRole("dialog")).toContainElement(screen.getByTestId("k8s-log-tools"));
    expect(screen.queryByTestId("k8s-side")).toBeNull();
  });

  it("a wide panel opens them beside the list, which stays on screen", async () => {
    await mountWithPod("k-wide");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const side = screen.getByTestId("k8s-side");
    expect(side).toContainElement(screen.getByTestId("k8s-log-tools"));
    // The list is still there, next to the pane.
    expect(screen.getByTestId("k8s-list-part")).toContainElement(
      screen.getByRole("button", { name: "View details" }),
    );
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.queryByTestId("k8s-side")).toBeNull();
  });

  it("the border between the list and the pane is dragged, and is there only with two parts", async () => {
    resetPanelShares();
    await mountWithPod("k-border");
    resize(1200);
    const list = screen.getByTestId("k8s-list-part");
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(list.style.width).toBe("");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const divider = screen.getByTestId("panel-divider");
    expect(divider).toHaveAttribute("data-split", "k8s");
    expect(divider.previousElementSibling).toBe(list);
    expect(divider.nextElementSibling).toBe(screen.getByTestId("k8s-side"));
    expect(list.style.width).toBe("50%");

    const row = list.parentElement!;
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 1000 });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([{ target: row }]);
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    await fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 10 });
    await fireEvent.pointerMove(divider, { pointerId: 1, clientX: 650, clientY: 10 });
    await fireEvent.pointerUp(divider, { pointerId: 1, clientX: 650, clientY: 10 });
    expect(panelSplits.shares.k8s).toBeCloseTo(0.65);
    expect(list.style.width).toBe("65%");
    // Docker's border is its own.
    expect(panelSplits.shares.docker).toBeUndefined();
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    resetPanelShares();
  });

  it("details that are open follow the panel across the threshold", async () => {
    await mountWithPod("k-cross");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByTestId("k8s-side")).toBeInTheDocument();
    resize(400);
    await waitFor(() => expect(screen.queryByTestId("k8s-side")).toBeNull());
    expect(screen.getByRole("dialog")).toContainElement(screen.getByTestId("k8s-log-tools"));
  });

  it("…and keep the view they were on: Describe stays Describe, not Overview again (v1.17)", async () => {
    await mountWithPod("k-keep");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const side = screen.getByTestId("k8s-side");
    await fireEvent.click(within(side).getByTestId("k8s-detail-tab-describe"));
    expect(within(side).queryByTestId("k8s-detail-overview")).toBeNull();

    // Wide → narrow: the pane gives way to the dialog, on the same view.
    resize(400);
    await waitFor(() => expect(screen.queryByTestId("k8s-side")).toBeNull());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByTestId("k8s-detail-overview")).toBeNull();
    expect(within(dialog).getByTestId("k8s-detail-tab-describe").className).toContain("text-accent");

    // Narrow → wide again.
    resize(1200);
    const again = await screen.findByTestId("k8s-side");
    expect(within(again).queryByTestId("k8s-detail-overview")).toBeNull();
  });

  it("…and the log reads on as it was: its filter survives the threshold (v1.34)", async () => {
    await mountWithPod("k-log-cross");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const side = screen.getByTestId("k8s-side");
    await fireEvent.input(within(side).getByRole("textbox", { name: "Filter lines" }), { target: { value: "ready" } });
    await fireEvent.click(within(side).getByTestId("k8s-log-live"));
    resize(400);
    await waitFor(() => expect(screen.queryByTestId("k8s-side")).toBeNull());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Filter lines" }).value).toBe("ready");
    expect(within(dialog).getByTestId("k8s-log-live")).toHaveAttribute("aria-pressed", "false");
  });

  it("a terminal-tab switch rebuilds the panel: the pod's details come back on their view (v1.34)", async () => {
    answer = (args) =>
      args.includes("pods") && args.includes("get")
        ? { stdout: JSON.stringify({ items: [POD] }), stderr: "", exitCode: 0 }
        : undefined;
    const first = render(K8sPanel, { props: { sessionId: "k-back", visible: true, sessionReady: true } });
    await idle();
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    await fireEvent.click(within(screen.getByTestId("k8s-side")).getByTestId("k8s-detail-tab-describe"));
    first.unmount();

    render(K8sPanel, { props: { sessionId: "k-back", visible: true, sessionReady: true } });
    await idle();
    resize(1200);
    const again = await screen.findByTestId("k8s-side");
    expect(within(again).getByTestId("k8s-detail-tab-describe").className).toContain("text-accent");
    expect(screen.getByTestId("k8s-row")).toHaveAttribute("aria-current", "true");
  });

  it("details opened anew start from the log", async () => {
    await mountWithPod("k-anew");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    await fireEvent.click(screen.getByTestId("k8s-detail-tab-yaml"));
    expect(screen.getByTestId("k8s-detail-tab-yaml").className).toContain("text-accent");
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByTestId("k8s-log-tools")).toBeInTheDocument();
  });

  it("a click on the row opens the details, and the list is laid out by its own width", async () => {
    await mountWithPod("k-row");
    resize(1200);
    const list = screen.getByTestId("k8s-list-part");
    expect(list).toHaveClass("@container");
    await fireEvent.click(screen.getByText("web-5f7c"));
    expect(screen.getByTestId("k8s-side-detail")).toBeInTheDocument();
    expect(screen.getByTestId("k8s-row")).toHaveAttribute("aria-current", "true");
    // jsdom gives the list no width of its own: a narrow list in a wide panel.
    expect(list).toHaveAttribute("data-list-wide", "false");
  });
});

// Stage 4 (ADR 0054): a workload's details, and a CronJob's run pods under it.
describe("K8sPanel — workloads (stage 4)", () => {
  const DEPLOY = {
    kind: "Deployment",
    metadata: { name: "rollout", namespace: "shop", uid: "uid-rollout", creationTimestamp: "2026-10-07T10:00:00Z" },
    spec: { replicas: 2, selector: { matchLabels: { app: "rollout" } }, strategy: { type: "Recreate" } },
    status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2 },
  };
  const CRON = { kind: "CronJob", metadata: { name: "report", namespace: "shop", uid: "uid-report" }, spec: { schedule: "*/1 * * * *" }, status: {} };
  const JOB = {
    kind: "Job",
    metadata: { name: "report-29901003", namespace: "shop", uid: "uid-job", ownerReferences: [{ kind: "CronJob", name: "report", uid: "uid-report", controller: true }] },
    spec: { completions: 1 },
    status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }] },
  };
  const RUN_POD = {
    metadata: { name: "report-29901003-wx9hk", namespace: "shop", creationTimestamp: "2026-10-07T10:00:00Z", ownerReferences: [{ kind: "Job", name: "report-29901003", controller: true }] },
    spec: { containers: [{ name: "report" }] },
    status: { phase: "Failed", containerStatuses: [{ name: "report", state: { terminated: { exitCode: 2, reason: "Error" } } }] },
  };
  const ok = (items: unknown[]) => ({ stdout: JSON.stringify({ items }), stderr: "", exitCode: 0 });

  it("a CronJob's run pods are grouped under the CronJob, asked of their Jobs", async () => {
    answer = (args) => {
      if (args.includes("get") && args.includes("pods")) return ok([RUN_POD]);
      if (args.includes("get") && args.includes("jobs")) return ok([JOB]);
      return undefined;
    };
    render(K8sPanel, { props: { sessionId: "k-cron-pods", visible: true, sessionReady: true } });
    await idle();
    expect(calls.some((c) => c.includes("get jobs -o json"))).toBe(true);
    const group = screen.getAllByTestId("k8s-group").find((g) => g.textContent?.includes("report"));
    expect(group).toBeDefined();
    expect(group!.textContent).not.toContain("report-29901003");
  });

  it("a click on a workload opens its details; a CronJob's runs are in them", async () => {
    answer = (args) => (args.includes("deployments,statefulsets,daemonsets,cronjobs,jobs") ? ok([DEPLOY, CRON, JOB]) : undefined);
    render(K8sPanel, { props: { sessionId: "k-work", visible: true, sessionReady: true } });
    await idle();
    await fireEvent.click(screen.getByRole("button", { name: "Workloads" }));
    await idle();
    const rows = screen.getAllByTestId("k8s-workload-row");
    // A CronJob's run is not a row of its own.
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("rollout"), expect.stringContaining("report")]);
    await fireEvent.click(rows[1]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("k8s-work-job")).toHaveTextContent("BackoffLimitExceeded");
    // Another row, picked while it is open, is shown in the same place.
    await fireEvent.click(rows[0]);
    expect(within(screen.getByRole("dialog")).getByTestId("k8s-work-overview")).toHaveTextContent("Recreate");
  });
});

// Stage 5 (ADR 0054): a node's details, and the volume claims of the Cluster view.
describe("K8sPanel — the Cluster view (stage 5)", () => {
  const ok = (items: unknown[]) => ({ stdout: JSON.stringify({ items }), stderr: "", exitCode: 0 });
  const NODE = {
    metadata: { name: "desktop-control-plane", labels: {} },
    status: { conditions: [{ type: "Ready", status: "True" }, { type: "DiskPressure", status: "True", reason: "KubeletHasDiskPressure" }], nodeInfo: { kubeletVersion: "v1.31.1" } },
  };
  const claim = (name: string, phase: string) => ({
    metadata: { name, namespace: "shop" },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "64Mi" } }, storageClassName: "standard" },
    status: { phase, ...(phase === "Bound" ? { capacity: { storage: "64Mi" } } : {}) },
  });
  const DB = { metadata: { name: "db-0", namespace: "shop" }, spec: { volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-db-0" } }] }, status: {} };
  const WAIT = {
    type: "Normal",
    reason: "WaitForFirstConsumer",
    involvedObject: { kind: "PersistentVolumeClaim", name: "spare" },
    metadata: { namespace: "shop" },
    message: "waiting for first consumer to be created before binding",
  };

  async function openCluster(id: string, pvcs: unknown[]) {
    answer = (args) => {
      if (args.includes("nodes")) return ok([NODE]);
      if (args.includes("persistentvolumeclaims")) return ok(pvcs);
      if (args.includes("events")) return ok([WAIT]);
      if (args.includes("get") && args.includes("pods")) return ok([DB]);
      return undefined;
    };
    render(K8sPanel, { props: { sessionId: id, visible: true, sessionReady: true } });
    await idle();
    const before = calls.length;
    await fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
    await idle();
    return calls.slice(before);
  }

  it("lists the claims with who mounts each and why one waits; the pods are asked only for them", async () => {
    await openCluster("k-claims", [claim("data-db-0", "Bound"), claim("spare", "Pending")]);
    const [data, spare] = screen.getAllByTestId("k8s-claim-row");
    expect(data).toHaveTextContent("mounted by db-0");
    expect(spare).toHaveTextContent("not mounted by any pod");
    expect(within(spare).getByTestId("k8s-claim-why")).toHaveTextContent("waiting for first consumer");
    expect(screen.getByTestId("k8s-node-pressure")).toHaveTextContent("DiskPressure");
  });

  it("asks no pods when there are no claims, and a click on a node opens its details", async () => {
    const asked = await openCluster("k-noclaims", []);
    expect(asked.some((c) => c.includes("persistentvolumeclaims"))).toBe(true);
    expect(asked.filter((c) => c.includes("get pods -o json"))).toEqual([]);
    await fireEvent.click(screen.getByTestId("k8s-node-row"));
    expect(within(screen.getByRole("dialog")).getByTestId("k8s-node-overview")).toHaveTextContent("Ready");
  });
});
